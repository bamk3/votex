require('dotenv').config();

const express    = require('express');
const multer     = require('multer');
const fs         = require('fs');
const path       = require('path');
const { PDFDocument } = require('pdf-lib');

const app     = express();
const PORT    = 3000;
const DATA    = path.join(__dirname, 'data');
const UPLOADS = path.join(__dirname, 'uploads');
const MP_OUT  = path.join(__dirname, 'mathpix_outputs');
const AVATARS = path.join(__dirname, 'avatars');
fs.mkdirSync(AVATARS, { recursive: true });


// ── helpers ───────────────────────────────────────────────────────────────────
const readJSON  = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const writeJSON = (f, d) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(d, null, 2));

// Human-readable upload folder: u_First_Last_YYYY-MM-DD
function makeUserFolder(name) {
  const safe = (name||'student').trim().replace(/[^a-zA-Z0-9 ]/g,'').replace(/\s+/g,'_');
  return `u_${safe}_${new Date().toISOString().slice(0,10)}`;
}

// ensure data files exist
['users.json','submissions.json','notifications.json','messages.json','feedbacks.json','staff_chat.json'].forEach(f => {
  const fp = path.join(DATA, f);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, f === 'users.json'
    ? JSON.stringify([{id:'admin',name:'Admin',email:'admin@maktech.co.uk',password:'admin123',role:'admin',createdAt:new Date().toISOString()}],null,2)
    : '[]');
});
if (!fs.existsSync(path.join(DATA,'pricing.json')))
  fs.writeFileSync(path.join(DATA,'pricing.json'), JSON.stringify({pricePerPage:1000,currency:'CDF',managerRate:10,minPayout:5000},null,2));
else {
  // Ensure minPayout exists for older installs
  const p = readJSON('pricing.json');
  if (p.minPayout === undefined) { p.minPayout = 5000; writeJSON('pricing.json', p); }
}

// ── multer: feedback files (student sends after doc is done) ──────────────────
const feedbackStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(__dirname, 'feedback', req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ts   = new Date().toISOString().replace(/:/g,'-').replace(/\..+/,'');
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_');
    cb(null, `fb_${ts}_${safe}`);
  }
});
const uploadFeedback = multer({ storage: feedbackStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── multer: user avatar photos ────────────────────────────────────────────────
const avatarStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(AVATARS, req.params.userId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) { cb(null, 'avatar' + path.extname(file.originalname).toLowerCase()); }
});
const uploadAvatar = multer({ storage: avatarStorage, limits: { fileSize: 3 * 1024 * 1024 } });

// ── multer: student uploads ───────────────────────────────────────────────────
// Always resolve the upload folder from users.json — never trust the client value
function resolveUserFolder(userId) {
  try {
    const users = readJSON('users.json');
    const user  = users.find(u => u.id === userId);
    return user && user.uploadFolder ? user.uploadFolder : userId;
  } catch { return userId; }
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const folder = resolveUserFolder(req.body.userId);
    const dir = path.join(UPLOADS, folder);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ts   = new Date().toISOString().replace(/:/g,'-').replace(/\..+/,'');
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_');
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── multer: payment proof screenshots ────────────────────────────────────────
const proofStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(__dirname, 'payments', req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ts   = new Date().toISOString().replace(/:/g,'-').replace(/\..+/,'');
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_');
    cb(null, `proof_${ts}_${safe}`);
  }
});
const uploadProof = multer({ storage: proofStorage, limits: { fileSize: 5 * 1024 * 1024 } });

// ── multer: admin final-doc upload ────────────────────────────────────────────
const finalStorage = multer.diskStorage({
  destination(req, file, cb) {
    const subs = readJSON('submissions.json');
    const sub  = subs.find(s => s.id === req.params.id);
    const folder = sub ? resolveUserFolder(sub.userId) : 'unknown';
    const dir  = path.join(UPLOADS, folder);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ts   = new Date().toISOString().replace(/:/g,'-').replace(/\..+/,'');
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_');
    cb(null, `final_${ts}_${safe}`);
  }
});
const uploadFinal = multer({ storage: finalStorage, limits: { fileSize: 20 * 1024 * 1024 } });

// ── middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(__dirname));
// serve template files
app.use('/templates', express.static(path.join(__dirname, 'templates')));

// ── TEMPLATES ─────────────────────────────────────────────────────────────────
app.get('/api/templates', (req, res) => {
  const dir = path.join(__dirname, 'templates');
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter(f => /\.(pdf|docx|doc)$/i.test(f));
  res.json(files);
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = readJSON('users.json').find(u =>
    u.email.toLowerCase() === email.trim().toLowerCase() && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
  const { password: _, ...safe } = user;
  res.json({ user: safe });
});

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required.' });
  const users = readJSON('users.json');
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: 'Email already registered.' });
  const uploadFolder = makeUserFolder(name.trim());
  const user = { id:'u_'+Date.now(), name:name.trim(), email:email.trim().toLowerCase(), password, role:'student', uploadFolder, createdAt:new Date().toISOString() };
  users.push(user);
  writeJSON('users.json', users);
  fs.mkdirSync(path.join(UPLOADS, uploadFolder), { recursive: true });
  const { password: _, ...safe } = user;
  res.json({ user: safe });
});

app.get('/api/users', (req, res) => {
  res.json(readJSON('users.json').map(({ password: _, ...u }) => u));
});

app.get('/api/users/:userId', (req, res) => {
  const { userId } = req.params;
  const users = readJSON('users.json');

  // Find the specific user in the array
  const user = users.find(u => u.id === userId);

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  // Return the specific value you need
  res.json({ totalPaid: user.totalPaid || 0 });
});

//Cron-job

app.get('/api/cron-ping', (req, res) => {
    // Send a tiny response to keep the cron job happy
    res.status(200).send('OK'); 
});

// ── AVATAR ────────────────────────────────────────────────────────────────────
app.post('/api/users/:userId/avatar', uploadAvatar.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file.' });
  res.json({ ok: true, path: `/api/users/${req.params.userId}/avatar` });
});
app.get('/api/users/:userId/avatar', (req, res) => {
  const dir = path.join(AVATARS, req.params.userId);
  const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  for (const ext of exts) {
    const fp = path.join(dir, 'avatar' + ext);
    if (fs.existsSync(fp)) return res.sendFile(fp);
  }
  res.status(404).send('No avatar.');
});

// ── MANAGERS (admin creates manager accounts) ─────────────────────────────────
app.post('/api/managers', (req, res) => {
  const { name, email, password, tagName } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required.' });
  const users = readJSON('users.json');
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: 'Email already registered.' });
  const user = { id:'m_'+Date.now(), name:name.trim(), email:email.trim().toLowerCase(), password, role:'manager', tagName:(tagName||'').trim()||name.trim(), createdAt:new Date().toISOString() };
  users.push(user);
  writeJSON('users.json', users);
  const { password:_, ...safe } = user;
  res.json({ user: safe });
});
app.get('/api/managers', (req, res) => {
  res.json(readJSON('users.json').filter(u=>u.role==='manager'));
});

// STUDENTS LIST

app.get('/api/students', (req, res) => {
  res.json(readJSON('users.json').filter(u=>u.role==='student').map(({uploadFolder:_,...u})=>u));
});

// ── CAFES (admin creates cafe accounts) ─────────────────────────────────
app.post('/api/cafes', (req, res) => {
  const { name, email, password, tagName } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required.' });
  const users = readJSON('users.json');
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: 'Email already registered.' });
  const user = { id:'c_'+Date.now(), name:name.trim(), email:email.trim().toLowerCase(), password, role:'cafe', tagName:(tagName||'').trim()||name.trim(), createdAt:new Date().toISOString() };
  users.push(user);
  writeJSON('users.json', users);
  const { password:_, ...safe } = user;
  res.json({ user: safe });
});
app.get('/api/cafes', (req, res) => {
  res.json(readJSON('users.json').filter(u=>u.role==='cafe'));
});



// ── BATCH ASSIGNMENT (admin assigns batch to manager) ─────────────────────────
app.patch('/api/batches/:batchId/assign', (req, res) => {
  const { managerId, managerName } = req.body;
  const subs = readJSON('submissions.json');
  const batch = subs.filter(s => s.batchId === req.params.batchId);
  if (!batch.length) return res.status(404).json({ error: 'Batch not found.' });
  batch.forEach(s => { const i = subs.findIndex(x=>x.id===s.id); subs[i].assignedTo = managerId ? { id:managerId, name:managerName } : null; });
  writeJSON('submissions.json', subs);
  if (managerId) {
    const notifs = readJSON('notifications.json');
    notifs.unshift({ id:'n_'+Date.now(), type:'assignment',
      to: managerId,       // manager's user ID — filtered in ManagerDash
      toName: managerName,
      subject:`Commande confiée à vous — ${batch[0].userName}`,
      body:`Il vous a été assigné de traiter ${batch.length} doc(s) de ${batch[0].userName}:\n${batch.map(s=>`• ${s.fileName}`).join('\n')}`,
      sentAt:new Date().toISOString(), read:false });
    // explicitly NOT adding an admin notification here
    writeJSON('notifications.json', notifs.slice(0,100));
  }
  res.json({ ok: true });
});

// ── STAFF CHAT (admin + managers) ─────────────────────────────────────────────
app.get('/api/staff-chat', (req, res) => res.json(readJSON('staff_chat.json')));
app.post('/api/staff-chat', (req, res) => {
  const { fromId, fromName, role, text } = req.body;
  if (!fromId || !text) return res.status(400).json({ error: 'Missing fields.' });
  const msg = { id:'sc_'+Date.now()+'_'+Math.random().toString(36).slice(2), fromId, fromName, role, text, sentAt:new Date().toISOString() };
  const chat = readJSON('staff_chat.json');
  chat.push(msg);
  writeJSON('staff_chat.json', chat.slice(-200)); // keep last 200 msgs
  res.json({ message: msg });
});

// ── FILE UPLOAD (student) ─────────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });

  const pricing = readJSON('pricing.json');
  let pages = null;

  if (req.file.mimetype === 'application/pdf') {
    try {
      const bytes  = fs.readFileSync(req.file.path);
      const pdfDoc = await PDFDocument.load(bytes);
      pages = pdfDoc.getPageCount();
    } catch (e) {
      console.error('PDF page count error:', e.message);
      pages = 1;
    }
  } else if (req.file.mimetype.startsWith('image/')) {
    pages = 1; // each image = 1 page
  }

  // ── count total images already in this submission batch ──────────────────
  // (for multi-file uploads the frontend calls once per file, so pages=1 each)
  const price = pages != null ? pages * pricing.pricePerPage : null;

  const sub = {
    id:           's_'+Date.now()+'_'+Math.random().toString(36).slice(2),
    batchId:      req.body.batchId || ('batch_'+Date.now()),
    userId:       req.body.userId,
    uploadFolder: resolveUserFolder(req.body.userId),
    userName:     req.body.userName,
    userEmail:    req.body.userEmail,
    isMathDoc:    req.body.isMathDoc === 'false' ? false : true, // default true for backwards compat
    fileName:     req.file.originalname,
    storedName:   req.file.filename,
    fileType:     req.file.mimetype,
    fileSize:     req.file.size,
    notes:        req.body.notes || '',
    templateName: req.body.templateName || '',
    uploadedAt:   new Date().toISOString(),
    status:       'awaiting_payment',
    pages,
    price,
    paid:         false,
    finalDoc:     null   // will be set when admin sends the typed result
  };

  const subs = readJSON('submissions.json');
  const isFirstInBatch = !subs.some(s => s.batchId === sub.batchId);
  subs.push(sub);
  writeJSON('submissions.json', subs);

  const notifs = readJSON('notifications.json');
  if (isFirstInBatch) {
    // Admin notification
    notifs.unshift({
      id:'n_'+Date.now(), type:'new_submission', batchId: sub.batchId,
      to:'admin@maktech.co.uk', toName:'Admin',
      subject:`New batch from ${sub.userName}`,
      body:`${sub.userName} started a new batch.\n• ${sub.fileName} — ${pages ?? '?'} pages · ${price != null ? pricing.currency+' '+price : 'N/A'}${sub.templateName ? '    📄 Template: '+sub.templateName.replace(/\.pdf$/i,'').replace(/_/g,' ') : ''} ${sub.notes ? '\n📝 Commentaire: '+sub.notes : '\n'}`,
      submissionId: sub.id,
      sentAt:new Date().toISOString(), read:false
    });
    // Manager notifications (view-only awareness — only unassigned managers)
    const managers = readJSON('users.json').filter(u => u.role === 'manager');
    managers.forEach(mgr => {
      notifs.unshift({
        id:'nm_'+Date.now()+'_'+mgr.id, type:'new_submission_manager', batchId: sub.batchId,
        to: mgr.id, toName: mgr.name,
        subject:`Nouvelle commande de ${sub.userName}`,
        body:`${sub.userName} a soumis une nouvelle commande. Vous pouvez demander une affectation auprès de l'administrateur.${sub.templateName ? '\n📄 Template: '+sub.templateName.replace(/\.pdf$/i,'').replace(/_/g,' ') : ''} ${sub.notes ? '\n📝 Commentaire: '+sub.notes : ''}`,
        submissionId: sub.id,
        sentAt:new Date().toISOString(), read:false
      });
    });
  } else {
    // Update existing admin batch notification
    const existingIdx = notifs.findIndex(n => n.batchId === sub.batchId && n.to === 'admin@maktech.co.uk');
    if (existingIdx !== -1) {
      const batchSubs = subs.filter(s => s.batchId === sub.batchId);
      const batchTotal = batchSubs.reduce((a,s)=>a+(s.price||0),0);
      notifs[existingIdx].subject = `New batch from ${sub.userName} (${batchSubs.length} files)`;
      const templateLine = sub.templateName ? `\n📄 Template: ${sub.templateName.replace(/\.pdf$/i,'').replace(/_/g,' ')}` : '';
      notifs[existingIdx].body = `${sub.userName} (${sub.userEmail}) uploaded ${batchSubs.length} files:\n${batchSubs.map(s=>`• ${s.fileName} — ${s.pages??'?'}pp`).join('\n')}\nTotal: ${pricing.currency} ${batchTotal}${templateLine}`;
      notifs[existingIdx].read = false;
    }
  }
  writeJSON('notifications.json', notifs.slice(0,300));

  res.json({ submission: sub });
});

// ── FILE UPLOAD (Cafe) ─────────────────────────────────────────────────────
app.post('/api/uploadCafe', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });

  const pricing = readJSON('pricing.json');
  let pages = null;

  if (req.file.mimetype === 'application/pdf') {
    try {
      const bytes  = fs.readFileSync(req.file.path);
      const pdfDoc = await PDFDocument.load(bytes);
      pages = pdfDoc.getPageCount();
    } catch (e) {
      console.error('PDF page count error:', e.message);
      pages = 1;
    }
  } else if (req.file.mimetype.startsWith('image/')) {
    pages = 1; // each image = 1 page
  }

  // ── count total images already in this submission batch ──────────────────
  // (for multi-file uploads the frontend calls once per file, so pages=1 each)
  const price = pages != null ? pages * pricing.pricePerPageCafe : null;

  const sub = {
    id:           's_'+Date.now()+'_'+Math.random().toString(36).slice(2),
    batchId:      req.body.batchId || ('batch_'+Date.now()),
    userId:       req.body.userId,
    uploadFolder: resolveUserFolder(req.body.userId),
    userName:     req.body.userName,
    userEmail:    req.body.userEmail,
    isMathDoc:    req.body.isMathDoc === 'false' ? false : true, // default true for backwards compat
    fileName:     req.file.originalname,
    storedName:   req.file.filename,
    fileType:     req.file.mimetype,
    fileSize:     req.file.size,
    notes:        req.body.notes || '',
    templateName: req.body.templateName || '',
    uploadedAt:   new Date().toISOString(),
    status:       'awaiting_payment',
    pages,
    price,
    paid:         false,
    finalDoc:     null   // will be set when admin sends the typed result
  };

  const subs = readJSON('submissions.json');
  const isFirstInBatch = !subs.some(s => s.batchId === sub.batchId);
  subs.push(sub);
  writeJSON('submissions.json', subs);

  const notifs = readJSON('notifications.json');
  if (isFirstInBatch) {
    // Admin notification
    notifs.unshift({
      id:'n_'+Date.now(), type:'new_submission', batchId: sub.batchId,
      to:'admin@maktech.co.uk', toName:'Admin',
      subject:`New batch from ${sub.userName}`,
      body:`${sub.userName} started a new batch.\n• ${sub.fileName} — ${pages ?? '?'} pages · ${price != null ? pricing.currency+' '+price : 'N/A'}${sub.templateName ? '    📄 Template: '+sub.templateName.replace(/\.pdf$/i,'').replace(/_/g,' ') : ''} ${sub.notes ? '\n📝 Commentaire: '+sub.notes : '\n'}`,
      submissionId: sub.id,
      sentAt:new Date().toISOString(), read:false
    });
    // Manager notifications (view-only awareness — only unassigned managers)
    const managers = readJSON('users.json').filter(u => u.role === 'manager');
    managers.forEach(mgr => {
      notifs.unshift({
        id:'nm_'+Date.now()+'_'+mgr.id, type:'new_submission_manager', batchId: sub.batchId,
        to: mgr.id, toName: mgr.name,
        subject:`Nouvelle commande de ${sub.userName}`,
        body:`${sub.userName} a soumis une nouvelle commande. Vous pouvez demander une affectation auprès de l'administrateur.${sub.templateName ? '\n📄 Template: '+sub.templateName.replace(/\.pdf$/i,'').replace(/_/g,' ') : ''} ${sub.notes ? '\n📝 Commentaire: '+sub.notes : ''}`,
        submissionId: sub.id,
        sentAt:new Date().toISOString(), read:false
      });
    });
  } else {
    // Update existing admin batch notification
    const existingIdx = notifs.findIndex(n => n.batchId === sub.batchId && n.to === 'admin@maktech.co.uk');
    if (existingIdx !== -1) {
      const batchSubs = subs.filter(s => s.batchId === sub.batchId);
      const batchTotal = batchSubs.reduce((a,s)=>a+(s.price||0),0);
      notifs[existingIdx].subject = `New batch from ${sub.userName} (${batchSubs.length} files)`;
      const templateLine = sub.templateName ? `\n📄 Template: ${sub.templateName.replace(/\.pdf$/i,'').replace(/_/g,' ')}` : '';
      notifs[existingIdx].body = `${sub.userName} (${sub.userEmail}) uploaded ${batchSubs.length} files:\n${batchSubs.map(s=>`• ${s.fileName} — ${s.pages??'?'}pp`).join('\n')}\nTotal: ${pricing.currency} ${batchTotal}${templateLine}`;
      notifs[existingIdx].read = false;
    }
  }
  writeJSON('notifications.json', notifs.slice(0,300));

  res.json({ submission: sub });
});





// ── SUBMISSIONS ───────────────────────────────────────────────────────────────
app.get('/api/submissions', (req, res) => {
  let subs = readJSON('submissions.json');
  if (req.query.userId) subs = subs.filter(s => s.userId === req.query.userId);
  res.json(subs);
});

app.patch('/api/submissions/:id', (req, res) => {
  const subs = readJSON('submissions.json');
  const idx  = subs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found.' });

  const oldStatus = subs[idx].status;
  subs[idx] = { ...subs[idx], ...req.body };
  writeJSON('submissions.json', subs);

  const sub = subs[idx];

  // auto-message on every status change
  if (req.body.status && req.body.status !== oldStatus) {
    const statusLabels = {
      awaiting_payment: 'Awaiting Payment',
      in_progress:      'In Progress',
      done:             'Done'
    };
    const label = statusLabels[req.body.status] || req.body.status;

    let body = `Votre document "${sub.fileName}" le statut de votre document a été mis à jour à: ${label.toUpperCase()}.`;
    if (req.body.status === 'in_progress')
      body += '\n\n Votre paiement a été confirmé et nous avons commencé à travailler sur votre document.';
    if (req.body.status === 'done')
      body += '\n\n Votre document est prêt. L\'administrateur vous enverra le fichier saisi sous peu — vous recevrez une autre notification lorsqu\'il sera prêt à être téléchargé.';

    const msgs = readJSON('messages.json');
    msgs.unshift({
      id:'m_'+Date.now(), fromId:'admin', fromName:'Admin',
      toId:sub.userId, toName:sub.userName, toEmail:sub.userEmail,
      subject:`Status Update: ${sub.fileName}`,
      body, submissionId:sub.id, submissionFileName:sub.fileName,
      sentAt:new Date().toISOString(), read:false
    });
    writeJSON('messages.json', msgs);

    const notifs = readJSON('notifications.json');
    notifs.unshift({
      id:'n_'+Date.now(), type:'status_update',
      to:sub.userEmail, toName:sub.userName,
      subject:`"${sub.fileName}" → ${label}`,
      body, sentAt:new Date().toISOString(), read:false
    });
    writeJSON('notifications.json', notifs.slice(0,100));
  }

  res.json(subs[idx]);
});

app.delete('/api/submissions/:id', (req, res) => {
  const subs = readJSON('submissions.json');
  const sub  = subs.find(s => s.id === req.params.id);
  if (sub) {
    const folder = sub.uploadFolder || sub.userId;
    const fp = path.join(UPLOADS, folder, sub.storedName);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    if (sub.finalDoc) {
      const fp2 = path.join(UPLOADS, folder, sub.finalDoc.storedName);
      if (fs.existsSync(fp2)) fs.unlinkSync(fp2);
    }
    if (sub.paymentProof) {
      const fp3 = path.join(__dirname, 'payments', sub.id, sub.paymentProof.storedName);
      if (fs.existsSync(fp3)) fs.unlinkSync(fp3);
    }
    // remove feedback files
    const fbDir = path.join(__dirname, 'feedback', sub.id);
    if (fs.existsSync(fbDir)) fs.rmSync(fbDir, { recursive: true, force: true });
    // remove feedbacks from data
    const feedbacks = readJSON('feedbacks.json');
    writeJSON('feedbacks.json', feedbacks.filter(f => f.submissionId !== sub.id));
  }
  writeJSON('submissions.json', subs.filter(s => s.id !== req.params.id));
  res.json({ ok: true });
});

// ── PAYMENT PROOF (student uploads screenshot) ────────────────────────────────
app.post('/api/submissions/:id/payment-proof', uploadProof.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });

  const subs = readJSON('submissions.json');
  const idx  = subs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Submission not found.' });

  subs[idx].paymentProof = {
    fileName:   req.file.originalname,
    storedName: req.file.filename
  };
  // propagate proof reference to all other subs in the same batch
  if (subs[idx].batchId) {
    subs.forEach((s, i) => {
      if (s.batchId === subs[idx].batchId && i !== idx && !s.paymentProof) {
        subs[i].paymentProof = { ...subs[idx].paymentProof, sharedFrom: subs[idx].id };
      }
    });
  }
  writeJSON('submissions.json', subs);
  // const vatRate = 1.16; // 16% VAT
  const vatRate = 0; // 
  const sub = subs[idx];
  const pricing = readJSON('pricing.json');
  const batchSubs = sub.batchId ? subs.filter(s=>s.batchId===sub.batchId) : [sub];
  const batchTotal = batchSubs.reduce((a,s)=>a+(s.price||0),0);
  const batchTTC = batchTotal * (1+vatRate);
  const fileList = batchSubs.map(s=>`• ${s.fileName} (${s.pages??'?'}pp) — ${pricing.currency} ${s.price}`).join('\n');

  // message to admin
  const msgs = readJSON('messages.json');
  msgs.unshift({
    id: 'm_'+Date.now()+'_'+Math.random().toString(36).slice(2),
    fromId: sub.userId, fromName: sub.userName,
    toId: 'admin', toName: 'Admin', toEmail: 'admin@maktech.co.uk',
    subject: `Preuve de paiement — commande de ${batchSubs.length} doc${batchSubs.length>1?'s':''} de ${sub.userName}`,
    body: `${sub.userName} (${sub.userEmail}) a soumis une preuve de paiement pour ${batchSubs.length} file${batchSubs.length>1?'s':''}:\n\n${fileList}\n\nSubtotal HT: ${pricing.currency} ${batchTotal}\nTVA (${vatRate*100}%): ${pricing.currency} ${(batchTotal*vatRate).toFixed(0)}\nTotal TTC: ${pricing.currency} ${batchTTC.toFixed(0)}\n\nProof file: ${req.file.originalname}\n\nVeuillez vérifier et confirmer pour commencer le traitement.\n\n L\'Admin`,
    submissionId: sub.id, submissionFileName: batchSubs.map(s=>s.fileName).join(', '),
    sentAt: new Date().toISOString(), read: false
  });
  writeJSON('messages.json', msgs);

  // notification to admin — update existing batch notif or create new
  const notifs = readJSON('notifications.json');
  // const existingIdx = notifs.findIndex(n => n.batchId === sub.batchId && n.type === 'new_submission');
  // if (existingIdx !== -1) {
  //   notifs[existingIdx].type = 'payment_ready';
  //   notifs[existingIdx].subject = `💰 Payment proof — ${sub.userName} (${batchSubs.length} files)`;
  //   notifs[existingIdx].body = `${sub.userName} submitted payment proof for ${batchSubs.length} file${batchSubs.length>1?'s':''}. Total TTC: ${pricing.currency} ${batchTTC.toFixed(0)}`;
  //   notifs[existingIdx].submissionId = sub.id;
  //   notifs[existingIdx].read = false;
  // } else {
    notifs.unshift({
      id: 'n_'+Date.now(), type: 'payment_ready', batchId: sub.batchId,
      to: 'admin@maktech.co.uk', toName: 'Admin',
      subject: `💰 Payment proof — ${sub.userName} (${batchSubs.length} files)`,
      body: `${sub.userName} submitted payment proof. Total TTC: ${pricing.currency} ${batchTTC.toFixed(0)}`,
      submissionId: sub.id,
      sentAt: new Date().toISOString(), read: false
    });
  // }
  writeJSON('notifications.json', notifs.slice(0,100));

  res.json({ submission: subs[idx] });
});

// admin downloads payment proof
app.get('/api/submissions/:id/payment-proof', (req, res) => {
  const sub = readJSON('submissions.json').find(s => s.id === req.params.id);
  if (!sub || !sub.paymentProof) return res.status(404).send('No payment proof on file.');
  const fp = path.join(__dirname, 'payments', sub.id, sub.paymentProof.storedName);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found on disk.');
  res.download(fp, sub.paymentProof.fileName);
});

// ── FINAL DOCUMENT (admin sends typed result to student) ──────────────────────
app.post('/api/submissions/:id/final', uploadFinal.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });

  const subs = readJSON('submissions.json');
  const idx  = subs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Submission not found.' });

  const finalDocRef = { fileName: req.file.originalname, storedName: req.file.filename };
  const batchId = subs[idx].batchId;

  // Apply finalDoc to ALL subs in same batch (or just this one if no batch)
  const batchSubs = batchId ? subs.filter(s => s.batchId === batchId) : [subs[idx]];
  batchSubs.forEach(s => {
    const i = subs.findIndex(x => x.id === s.id);
    subs[i].finalDoc = finalDocRef;
    subs[i].status = 'done';
  });
  writeJSON('submissions.json', subs);

  const sub = subs[idx];
  const fileList = batchSubs.length > 1
    ? batchSubs.map(s => `• ${s.fileName}`).join('\n')
    : `"${sub.fileName}"`;

  // One notification per batch
  const msgs = readJSON('messages.json');
  msgs.unshift({
    id:'m_'+Date.now(), fromId:'admin', fromName:'Admin',
    toId:sub.userId, toName:sub.userName, toEmail:sub.userEmail,
    subject:`Your typed document ${batchSubs.length>1?'s are':'is'} ready`,
    body:`Salut ${sub.userName},\n\nVotre document saisi ${batchSubs.length>1?'sont':'est'} prêt pour le téléchargement. \n\nConnectez-vous et cliquez sur Télécharger à côté du numéro de la commande.\n\nCordialement, \n\nL'équipe voTex`,
    submissionId:sub.id, submissionFileName:batchSubs.map(s=>s.fileName).join(', '),
    sentAt:new Date().toISOString(), read:false
  });
  writeJSON('messages.json', msgs);

  // If the batch was handled by a manager, notify the admin
  const managerInfo = subs[idx].assignedTo;
  if (managerInfo) {
    const adminNotifs = readJSON('notifications.json');
    adminNotifs.unshift({
      id:'n_'+Date.now(), type:'manager_submitted',
      to:'admin@maktech.co.uk', toName:'Admin',
      subject:`Manager ${managerInfo.name} submitted typed doc for ${batchSubs[0].userName}`,
      body:`${managerInfo.name} has sent the typed document for:\n${batchSubs.map(s=>`• ${s.fileName}`).join('\n')}\n\nStudent: ${batchSubs[0].userName} (${batchSubs[0].userEmail})`,
      sentAt:new Date().toISOString(), read:false
    });
    writeJSON('notifications.json', adminNotifs.slice(0,100));
  }

  res.json({ submission: subs[idx] });
});

// student downloads the final doc
app.get('/api/submissions/:id/final', (req, res) => {
  const sub = readJSON('submissions.json').find(s => s.id === req.params.id);
  if (!sub || !sub.finalDoc) return res.status(404).send('Final document not available.');
  const folder = sub.uploadFolder || sub.userId;
  const fp = path.join(UPLOADS, folder, sub.finalDoc.storedName);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found on disk.');
  res.download(fp, sub.finalDoc.fileName);
});

// inline view of final doc (for PDF/image preview in browser)
app.get('/api/submissions/:id/final/view', (req, res) => {
  const sub = readJSON('submissions.json').find(s => s.id === req.params.id);
  if (!sub || !sub.finalDoc) return res.status(404).send('Final document not available.');
  const folder = sub.uploadFolder || sub.userId;
  const fp = path.join(UPLOADS, folder, sub.finalDoc.storedName);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found on disk.');
  res.sendFile(fp);
});

// ── FILE DOWNLOAD (original upload) ──────────────────────────────────────────
app.get('/api/files/:folder/:filename', (req, res) => {
  const fp = path.join(UPLOADS, req.params.folder, req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found.');
  res.download(fp);
});
// Inline preview (opens in browser, no download dialog)
app.get('/api/files/:folder/:filename/preview', (req, res) => {
  const fp = path.join(UPLOADS, req.params.folder, req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found.');
  res.sendFile(fp);
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
app.get('/api/notifications', (req, res) => res.json(readJSON('notifications.json')));
app.patch('/api/notifications/:id', (req, res) => {
  const notifs = readJSON('notifications.json');
  const idx    = notifs.findIndex(n => n.id === req.params.id);
  if (idx !== -1) {
    if (req.body.readerId) {
      // Per-reader: push readerId into readBy[] without touching other readers
      if (!notifs[idx].readBy) notifs[idx].readBy = [];
      if (!notifs[idx].readBy.includes(req.body.readerId))
        notifs[idx].readBy.push(req.body.readerId);
    } else {
      notifs[idx] = { ...notifs[idx], ...req.body };
    }
    writeJSON('notifications.json', notifs);
  }
  res.json({ ok: true });
});

// ── MESSAGES ──────────────────────────────────────────────────────────────────
app.get('/api/messages', (req, res) => {
  let msgs = readJSON('messages.json');
  if (req.query.userId) msgs = msgs.filter(m => m.toId === req.query.userId);
  res.json(msgs);
});
app.post('/api/messages', (req, res) => {
  const { toId, toName, toEmail, fromId, fromName, subject, body, submissionId, submissionFileName } = req.body;
  if (!toId || !subject || !body) return res.status(400).json({ error: 'Missing fields.' });
  const msg = {
    id:'m_'+Date.now()+'_'+Math.random().toString(36).slice(2),
    fromId: fromId || 'admin',
    fromName: fromName || 'Admin',
    toId, toName, toEmail, subject, body,
    submissionId: submissionId || null,
    submissionFileName: submissionFileName || null,
    isStudentReply: req.body.isStudentReply || false,
    replyBlocked: false,
    sentAt:new Date().toISOString(), read:false
  };
  const msgs = readJSON('messages.json');
  msgs.unshift(msg);
  writeJSON('messages.json', msgs);

  // if message is from a student to admin/manager, log a notification
  if (toId === 'admin' || req.body.isStudentReply) {
    const notifs = readJSON('notifications.json');
    notifs.unshift({
      id:'n_'+Date.now(), type:'student_reply',
      to: toId==='admin' ? 'admin@maktech.co.uk' : toId,
      toName: toName || 'Admin',
      subject: `Student reply: ${subject}`,
      body,
      sentAt:new Date().toISOString(), read:false
    });
    writeJSON('notifications.json', notifs.slice(0,300));
  }

  res.json({ message: msg });
});
app.patch('/api/messages/:id', (req, res) => {
  const msgs = readJSON('messages.json');
  const idx  = msgs.findIndex(m => m.id === req.params.id);
  if (idx !== -1) {
    if (req.body.readerId) {
      // Per-reader tracking: push readerId into readBy[] without overwriting for others
      if (!msgs[idx].readBy) msgs[idx].readBy = [];
      if (!msgs[idx].readBy.includes(req.body.readerId)) {
        msgs[idx].readBy.push(req.body.readerId);
      }
    } else {
      msgs[idx] = { ...msgs[idx], ...req.body };
    }
    writeJSON('messages.json', msgs);
  }
  res.json({ ok: true });
});

// ── FEEDBACK (student sends after typed doc received) ─────────────────────────
app.post('/api/submissions/:id/feedback', uploadFeedback.single('file'), (req, res) => {
  const sub = readJSON('submissions.json').find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });

  const fb = {
    id:           'fb_'+Date.now()+'_'+Math.random().toString(36).slice(2),
    submissionId: req.params.id,
    submissionFileName: sub.fileName,
    userId:       sub.userId,
    userName:     sub.userName,
    text:         req.body.text || '',
    file:         req.file ? { fileName: req.file.originalname, storedName: req.file.filename, mimeType: req.file.mimetype } : null,
    sentAt:       new Date().toISOString(),
    read:         false
  };

  const feedbacks = readJSON('feedbacks.json');
  feedbacks.unshift(fb);
  writeJSON('feedbacks.json', feedbacks);

  // Always notify admin about feedback
  const notifs = readJSON('notifications.json');
  notifs.unshift({
    id:'n_'+Date.now(), type:'feedback',
    to:'admin@maktech.co.uk', toName:'Admin',
    subject:`Feedback on "${sub.fileName}" from ${sub.userName}`,
    body: fb.text || (fb.file ? `[${fb.file.mimeType.startsWith('audio')?'Voice note':'Screenshot'}: ${fb.file.fileName}]` : ''),
    submissionId: sub.id, userId: sub.userId, userName: sub.userName,
    sentAt: new Date().toISOString(), read: false
  });
  // Also notify assigned manager (separately — independent read status)
  if (sub.assignedTo) {
    notifs.unshift({
      id:'n_'+Date.now()+'_mgr', type:'feedback',
      to: sub.assignedTo.id, toName: sub.assignedTo.name,
      subject:`Feedback on "${sub.fileName}" from ${sub.userName}`,
      body: fb.text || (fb.file ? `[${fb.file.mimeType.startsWith('audio')?'Voice note':'Screenshot'}: ${fb.file.fileName}]` : ''),
      submissionId: sub.id, userId: sub.userId, userName: sub.userName,
      sentAt: new Date().toISOString(), read: false
    });
  }
  writeJSON('notifications.json', notifs.slice(0,200));

  res.json({ feedback: fb });
});

app.get('/api/submissions/:id/feedbacks', (req, res) => {
  const feedbacks = readJSON('feedbacks.json').filter(f => f.submissionId === req.params.id);
  res.json(feedbacks);
});

// mark feedback read
app.patch('/api/feedbacks/:id', (req, res) => {
  const feedbacks = readJSON('feedbacks.json');
  const idx = feedbacks.findIndex(f => f.id === req.params.id);
  if (idx !== -1) { feedbacks[idx] = { ...feedbacks[idx], ...req.body }; writeJSON('feedbacks.json', feedbacks); }
  res.json({ ok: true });
});

// serve feedback file
app.get('/api/feedback/:submissionId/:filename', (req, res) => {
  const fp = path.join(__dirname, 'feedback', req.params.submissionId, req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found.');
  res.sendFile(fp);
});

// all feedbacks (admin view)
app.get('/api/feedbacks', (req, res) => {
  res.json(readJSON('feedbacks.json'));
});

// inline proof image view (for embedding in chat)
app.get('/api/submissions/:id/payment-proof/view', (req, res) => {
  const allSubs = readJSON('submissions.json');
  const sub = allSubs.find(s => s.id === req.params.id);
  if (!sub || !sub.paymentProof) return res.status(404).send('No proof on file.');
  // if proof is shared from another sub, use that sub's folder
  const proofSubId = sub.paymentProof.sharedFrom || sub.id;
  const fp = path.join(__dirname, 'payments', proofSubId, sub.paymentProof.storedName);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found on disk.');
  res.sendFile(fp);
});

// confirm payment for an entire batch
app.patch('/api/batches/:batchId/confirm-payment', (req, res) => {
  const subs = readJSON('submissions.json');
  const batch = subs.filter(s => s.batchId === req.params.batchId);
  if (!batch.length) return res.status(404).json({ error: 'Batch not found.' });

  // Mark every sub in the batch as paid + in_progress
  batch.forEach(s => {
    const i = subs.findIndex(x => x.id === s.id);
    subs[i].paid = true;
    subs[i].status = 'in_progress';
  });

  const msgs = readJSON('messages.json');
  const fileList = batch.map(s => `• ${s.fileName}`).join('\n');
  msgs.unshift({
    id:'m_'+Date.now()+'_'+Math.random().toString(36).slice(2),
    fromId:'admin', fromName:'Admin',
    toId:batch[0].userId, toName:batch[0].userName, toEmail:batch[0].userEmail,
    subject:`Payment confirmed — ${batch.length} file${batch.length>1?'s':''} in your batch`,
    body:`Hi ${batch[0].userName},\n\nVotre paiement a été confirmé pour le(s) fichier(s) suivant(s):\n${fileList}\n\nNous avons commencé à travailler sur ${batch.length>1?'ça':'ça'}. Vous serez notifié lorsque le document saisi sera prêt.\n\nCordialement,\n\nL'équipe voTex`,
    submissionId:batch[0].id, submissionFileName:batch.map(s=>s.fileName).join(', '),
    sentAt:new Date().toISOString(), read:false
  });
  writeJSON('submissions.json', subs);
  writeJSON('messages.json', msgs);
  res.json({ ok: true, updated: batch.length });
});

// mark batch feedback as closed (admin)
app.patch('/api/batches/:batchId/close-feedback', (req, res) => {
  const subs = readJSON('submissions.json');
  const batch = subs.filter(s => s.batchId === req.params.batchId);
  if (!batch.length) return res.status(404).json({ error: 'Batch not found.' });
  batch.forEach(s => { const i = subs.findIndex(x => x.id === s.id); subs[i].feedbackClosed = true; });
  writeJSON('submissions.json', subs);
  res.json({ ok: true });
});

// also allow per-submission close
app.patch('/api/submissions/:id/close-feedback', (req, res) => {
  const subs = readJSON('submissions.json');
  const idx = subs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found.' });
  // close entire batch
  const batchId = subs[idx].batchId;
  if (batchId) {
    subs.filter(s => s.batchId === batchId).forEach(s => { const i = subs.findIndex(x => x.id === s.id); subs[i].feedbackClosed = true; });
  } else {
    subs[idx].feedbackClosed = true;
  }
  writeJSON('submissions.json', subs);
  res.json({ ok: true });
});

// manager requests assignment for a batch
app.post('/api/batches/:batchId/request-assignment', (req, res) => {
  const { managerId, managerName, tagName } = req.body;
  const subs = readJSON('submissions.json');
  const batch = subs.filter(s => s.batchId === req.params.batchId);
  if (!batch.length) return res.status(404).json({ error: 'Batch not found.' });
  const notifs = readJSON('notifications.json');
  notifs.unshift({
    id:'n_'+Date.now(), type:'assignment_request',
    to:'admin@maktech.co.uk', toName:'Admin',
    subject:`Manager ${tagName||managerName} requests assignment — ${batch[0].userName}`,
    body:`${tagName?`[${tagName}] `:''} ${managerName} is requesting to be assigned the batch from ${batch[0].userName}:\n${batch.map(s=>`• ${s.fileName}`).join('\n')}`,
    submissionId: batch[0].id, batchId: req.params.batchId,
    managerId, managerName,
    sentAt:new Date().toISOString(), read:false
  });
  writeJSON('notifications.json', notifs.slice(0,200));
  res.json({ ok: true });
});

// manager marks batch as done (treatment complete, waiting for admin to send final doc)
app.patch('/api/batches/:batchId/mark-done', (req, res) => {
  const { managerName, tagName } = req.body;
  const subs = readJSON('submissions.json');
  const batch = subs.filter(s => s.batchId === req.params.batchId);
  if (!batch.length) return res.status(404).json({ error: 'Batch not found.' });
  // mark as manager_done (distinct from 'done' which is when student gets the file)
  batch.forEach(s => { const i = subs.findIndex(x=>x.id===s.id); subs[i].managerDone = true; });
  writeJSON('submissions.json', subs);
  // notify admin
  const notifs = readJSON('notifications.json');
  notifs.unshift({
    id:'n_'+Date.now(), type:'manager_done',
    to:'admin@maktech.co.uk', toName:'Admin',
    subject:`✅ Manager ${tagName||managerName} completed batch — ${batch[0].userName}`,
    body:`${tagName?`[${tagName}] `:''} ${managerName} has finished working on the batch from ${batch[0].userName}:\n${batch.map(s=>`• ${s.fileName}`).join('\n')}\n\nYou can now review and send the final document to the student.`,
    batchId: req.params.batchId, submissionId: batch[0].id,
    sentAt:new Date().toISOString(), read:false
  });
  writeJSON('notifications.json', notifs.slice(0,200));
  res.json({ ok: true });
});

// ── MATHPIX OCR ───────────────────────────────────────────────────────────────
app.post('/api/batches/:batchId/mathpix', async (req, res) => {
  const pricing = readJSON('pricing.json');
  const appId  = process.env.mpAppId || null;
  const appKey = process.env.mpAppKey || null;
  if (!appId || !appKey) return res.status(400).json({ error: 'MathPix credentials not configured. Please set them in the Pricing tab.' });

  const subs = readJSON('submissions.json');
  const batch = subs.filter(s => s.batchId === req.params.batchId)
    .sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));
  if (!batch.length) return res.status(404).json({ error: 'Batch not found.' });

  // Determine mode from the stored flag on submissions (set at upload time)
  const isMath = batch[0].isMathDoc !== false; // default true

  fs.mkdirSync(MP_OUT, { recursive: true });

  const results = [];

  // ── OPENAI HYBRID OCR CLEANUP ────────────────────────────────────────────────

async function improveOCRWithOpenAI({
  rawText,
  mimeType,
  base64Image,
  language = 'French',
  isMath = false
  }) {

  const pricing = readJSON('pricing.json');

  const openaiKey =
    process.env.openaiKey || null;

  // If no OpenAI key, fallback to raw OCR
  if (!openaiKey) {
    console.log('No OpenAI key configured, skipping OCR cleanup. To enable, set your OpenAI API key in the Pricing tab.');
    return rawText;}

  // Skip empty OCR
  if (!rawText || !rawText.trim()) {
    return rawText;}

  try {

    const prompt = `
You are verifying OCR extracted from a handwritten document.

The OCR text was produced by Mathpix.

Use BOTH:
1. the OCR text
2. the original handwritten image

to produce the most accurate transcription possible.

RULES:
- Preserve original wording
- Preserve original language
- Preserve formatting
- Preserve paragraph structure
- Preserve equations exactly
- Correct OCR mistakes
- Fix spacing
- Fix punctuation
- Restore accents if obvious
- Do NOT summarize
- Do NOT paraphrase
- Do NOT rewrite stylistically
- If uncertain, keep the OCR wording
- If unreadable, write [unclear]

Document language: ${language}

Math content present: ${isMath ? 'YES' : 'NO'}

OCR TEXT:
"""
${rawText}
"""
`;

    const aiRes = await fetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',

        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({

          model: 'gpt-4.1',

          temperature: 0,

          messages: [
            {
              role: 'system',
              content:
                'You are an OCR verification engine.'
            },

            {
              role: 'user',

              content: [

                {
                  type: 'text',
                  text: prompt
                },

                {
                  type: 'image_url',

                  image_url: {
                    url: `data:${mimeType};base64,${base64Image}`
                  }
                }
              ]
            }
          ]
        })
      }
    );

    const aiData = await aiRes.json();

    return (
      aiData?.choices?.[0]?.message?.content?.trim()
      || rawText
    );

  } catch (err) {

    console.error(
      'OpenAI OCR cleanup error:',
      err
    );

    return rawText;
  }
}


  for (const sub of batch) {
    const folder = resolveUserFolder(sub.userId);
    const fp = path.join(UPLOADS, folder, sub.storedName);
    if (!fs.existsSync(fp)) { results.push({ file: sub.fileName, error: 'File not found on disk.' }); continue; }

    try {
      const isPDF = sub.fileType === 'application/pdf';
      const fileData = fs.readFileSync(fp);
      const mimeType = sub.fileType || 'image/jpeg';

      if (isMath) {
        // ── MATH MODE: LaTeX output ──────────────────────────────────────────
        if (isPDF) {
          const formData = new FormData(); 
          formData.append('file', new Blob([fileData]), sub.fileName); 
          formData.append('options_json', JSON.stringify({ conversion_formats: {docx: true, latex: true }, ocr: ['math', 'text'], enable_spell_check: true, languages: ['en', 'fr'], rm_spaces: true }));
          const submitRes = await fetch('https://api.mathpix.com/v3/pdf', 
            { method: 'POST', headers: { 'app_id': appId, 'app_key': appKey },
             body: formData });
          
            const submitData = await submitRes.json();
          if (submitData.error) { results.push({ file: sub.fileName, error: submitData.error }); continue; }
          const pdfId = submitData.pdf_id;
          if (!pdfId) { results.push({ file: sub.fileName, error: 'No pdf_id returned by MathPix' }); continue; }
          let latex = null;
          for (let attempt = 0; attempt < 45; attempt++) {
            await new Promise(r => setTimeout(r, 2000));
            const statusData = await (await fetch(`https://api.mathpix.com/v3/pdf/${pdfId}`, { headers: { 'app_id': appId, 'app_key': appKey } })).json();
            if (statusData.status === 'processed' || statusData.status === 'completed') {
            const late = await fetch(`https://api.mathpix.com/v3/pdf/${pdfId}.mmd`, { headers: { 'app_id': appId, 'app_key': appKey } });
            latex = Buffer.from(await late.arrayBuffer())
            
            break;
            } else if (statusData.status === 'error') { results.push({ file: sub.fileName, error: statusData.error_info?.message || 'PDF processing failed' }); break; }
          }
          if (latex !== null) results.push({ file: sub.fileName, isPDF: true, latex, outputType: 'latex' });
          else if (!results.find(r => r.file === sub.fileName)) results.push({ file: sub.fileName, error: 'PDF processing timed out (> 90 s)' });
        } else {
        const b64 = fileData.toString('base64');
        const mpData = await (await fetch('https://api.mathpix.com/v3/text', {
        method: 'POST', 
        headers: { 
          'app_id': appId, 
          'app_key': appKey, 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ 
          src: `data:${mimeType};base64,${b64}`, 
          formats: ['text', 'latex_styled'], // 'text' is the primary return
          math_display_delimiters: ['$$', '$$'], 
          math_inline_delimiters: ['$', '$'], 

          rm_spaces: false, rm_newlines: false, enable_spell_check: true, languages: ['fr'],  include_line_data: true, text_mode: 'plain',   
        })
      })).json();

      if (mpData.error) { 
        results.push({ file: sub.fileName, error: mpData.error }); 
        continue; 
      }

      // results.push({ 
      //   file: sub.fileName, 
      //   isPDF: false, 
      //   // 'text' contains the primary OCR result
      //   text: mpData.text || '', 
      //   // 'latex_styled' is a secondary field if requested in formats
      //   latex: mpData.latex_styled || mpData.text || '', 
      //   outputType: 'latex' 
      // })
          const rawOCR =
          mpData.text ||
          mpData.latex_styled ||
          '';

        const cleanedOCR =
          await improveOCRWithOpenAI({

            rawText: rawOCR,

            mimeType,

            base64Image: b64,

            language: 'French',

            isMath: true
          });

        results.push({

          file: sub.fileName,

          isPDF: false,

          rawOCR,

          cleanedText: cleanedOCR.split('---')[1].trim(), // if AI added a separator, keep only the first part as cleaned text

          latex:
            mpData.latex_styled ||
            cleanedOCR.split('---')[1].trim(),

          outputType: 'latex'
        });
      }
      } else {
        // ── TEXT MODE: plain text output (no LaTeX) ──────────────────────────
        if (isPDF) {
          // Use MathPix PDF endpoint with mmd (Mathpix Markdown = clean readable text)
          const formData = new FormData();
          formData.append('file', new Blob([fileData]), sub.fileName);
          formData.append('options_json', JSON.stringify({
            conversion_formats: { docx: true, "tex.zip":true },
            rm_spaces: false, rm_newlines: false, ocr: ['text'], enable_spell_check: true, languages: ['fr'],  include_line_data: true, text_mode: 'plain'
          }));
          const submitRes = await fetch('https://api.mathpix.com/v3/pdf', {
            method: 'POST', headers: { 'app_id': appId, 'app_key': appKey }, body: formData
          });
          const submitData = await submitRes.json();
          if (submitData.error) { results.push({ file: sub.fileName, error: submitData.error }); continue; }
          const pdfId = submitData.pdf_id;
          if (!pdfId) { results.push({ file: sub.fileName, error: 'No pdf_id returned by MathPix' }); continue; }
          let plainText = null;
          for (let attempt = 0; attempt < 45; attempt++) {
            await new Promise(r => setTimeout(r, 2000));
            const statusData = await (await fetch(`https://api.mathpix.com/v3/pdf/${pdfId}`, { headers: { 'app_id': appId, 'app_key': appKey } })).json();
            if (statusData.status === 'processed' || statusData.status === 'completed') {
              plainText = await (await fetch(`https://api.mathpix.com/v3/pdf/${pdfId}.mmd`, { headers: { 'app_id': appId, 'app_key': appKey } })).text();
              // docxBuffer = Buffer.from(plainText);
              
              break;
            } else if (statusData.status === 'error') { results.push({ file: sub.fileName, error: statusData.error_info?.message || 'PDF processing failed' }); break; }
          }
          if (plainText !== null) results.push({ file: sub.fileName, isPDF: true, text: plainText, outputType: 'text' });
          else if (!results.find(r => r.file === sub.fileName)) results.push({ file: sub.fileName, error: 'PDF processing timed out (> 90 s)' });
        } else {
          // Image: text-only OCR, no math recognition
          const b64 = fileData.toString('base64');
          const mpData = await (await fetch('https://api.mathpix.com/v3/text', {
            method: 'POST', headers: { 'app_id': appId, 'app_key': appKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ src: `data:${mimeType};base64,${b64}`, 
              formats: ['text', 'latex_styled'], 
              // ✅ Enable spell checking
              enable_spell_check: true,
               // ✅ Language hint(s)
              languages: ['fr'],
              ocr: ['text'], 
              math_display_delimiters: ['$$', '$$'],
              math_inline_delimiters: ['$', '$'],
              rm_spaces: true,
              include_line_data: true,

            // Optional but recommended for text-heavy docs
            text_mode: 'plain'})
            // body: JSON.stringify({ src: `data:${mimeType};base64,${b64}`, formats: ['text'], ocr: ['text'], rm_spaces: true })
          })).json();
          if (mpData.error) { results.push({ file: sub.fileName, error: mpData.error }); continue; }
          // results.push({ file: sub.fileName, isPDF: false, text: mpData.text||'', outputType: 'text' })

          const rawOCR = mpData.text || '';

          const cleanedOCR =await improveOCRWithOpenAI({
                rawText: rawOCR,
                mimeType,
                base64Image: b64,
                language: 'French',
                isMath: false
              });

            results.push({file: sub.fileName,
              isPDF: false,
              rawOCR,
              text: cleanedOCR.split('---')[1].trim(),
              outputType: 'text'
            });
          ;
        }
      }
    } catch (e) {
      results.push({ file: sub.fileName, error: e.message });
    }
  }

  const leader = batch[0];
  const now = new Date();
  const safeName = (leader.userName||'student').replace(/[^a-zA-Z0-9]/g,'_');
  const studentFolder = resolveUserFolder(leader.userId);
  const studentMPDir  = path.join(MP_OUT, studentFolder);
  fs.mkdirSync(studentMPDir, { recursive: true });

  let outContent, outName, outExt;
if (isMath) {
    // Build full .tex document
    const docTitle = batch.map(s => s.fileName).join(', ').replace(/_/g, ' ').slice(0, 80);
    const bodyContent = results.map(r => {
      const heading = `\\section*{${r.file.replace(/[_#&%{}^~\\]/g, ' ')}}`;
      if (r.error) return `${heading}\n\\textcolor{red}{[OCR Error: ${r.error}]}\n`;
      return `${heading}\n${r.cleanedText || r.latex || r.text || '(empty)'}\n`;
    }).join('\n\\bigskip\n');
    outContent = `\\documentclass[12pt,a4paper]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\usepackage{amsfonts}\n\\usepackage{mathtools}\n\\usepackage{physics}\n\\usepackage{siunitx}\n\\usepackage{graphicx}\n\\usepackage{xcolor}\n\\usepackage{hyperref}\n\\usepackage{geometry}\n\\usepackage{microtype}\n\\usepackage{lmodern}\n\\geometry{margin=2.5cm}\n\\hypersetup{colorlinks=true,linkcolor=blue,urlcolor=blue}\n\n\\title{${docTitle}}\n\\author{${leader.userName}}\n\\date{${now.toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'})}}\n\n\\begin{document}\n\\maketitle\n\n${bodyContent}\n\n\\end{document}\n`;
    outExt = 'tex';
  } else {
    // Build plain text document
    outContent = results.map(r => `=== ${r.file} ===\n${r.error ? '[Error: '+r.error+']' : (r.cleanedText||r.text||'(empty)')}`).join('\n\n---\n\n');
    outExt = 'txt';
  }

  outName = `${safeName}_${now.toISOString().slice(0,10)}_${now.toISOString().slice(11,16).replace(':','-')}.${outExt}`;
  const storedRelative = `${studentFolder}/${outName}`;
  fs.writeFileSync(path.join(studentMPDir, outName), outContent, 'utf8');

  const leaderIdx = subs.findIndex(x => x.id === leader.id);
  subs[leaderIdx].mathpixResult = { fileName: outName, storedName: storedRelative, processedAt: now.toISOString(), outputType: isMath ? 'latex' : 'text' };
  writeJSON('submissions.json', subs);

  // Notify admin
  const notifs = readJSON('notifications.json');
  notifs.unshift({
    id:'n_'+Date.now(), type:'mathpix_done', batchId: batch[0].batchId,
    to:'admin@maktech.co.uk', toName:'Admin',
    subject:`MathPix OCR complete — ${batch.length} file${batch.length>1?'s':''} processed (${isMath?'LaTeX':'text'})`,
    body:`OCR complete for batch from ${leader.userName}.\nMode: ${isMath?'Math (LaTeX)':'Text (plain)'}\nFiles: ${batch.map(s=>s.fileName).join(', ')}\nOutput: ${outName}`,
    submissionId: leader.id, sentAt: now.toISOString(), read: false
  });
  // Also notify assigned manager if any
  if (leader.assignedTo) {
    notifs.unshift({
      id:'n_'+Date.now()+'_mgr', type:'mathpix_done', batchId: batch[0].batchId,
      to: leader.assignedTo.id, toName: leader.assignedTo.name,
      subject:`MathPix OCR complete — ${batch.length} file${batch.length>1?'s':''} processed`,
      body:`OCR complete for batch from ${leader.userName}. Output ready to review.`,
      submissionId: leader.id, sentAt: now.toISOString(), read: false
    });
  }
  writeJSON('notifications.json', notifs.slice(0,200));

  res.json({ ok: true, results, outputFile: outName, submissionId: leader.id, outputType: isMath ? 'latex' : 'text' });
});

// serve mathpix result to admin
app.get('/api/submissions/:id/mathpix-result', (req, res) => {
  const sub = readJSON('submissions.json').find(s => s.id === req.params.id);
  if (!sub || !sub.mathpixResult) return res.status(404).json({ error: 'No MathPix result.' });
  // storedName may be "studentFolder/file.tex" or legacy flat "file.tex"
  const fp = path.join(MP_OUT, sub.mathpixResult.storedName);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found.' });
  const content = fs.readFileSync(fp, 'utf8');
  res.json({ content, fileName: sub.mathpixResult.fileName, processedAt: sub.mathpixResult.processedAt });
});

// ── PRICING ───────────────────────────────────────────────────────────────────
app.get('/api/pricing',  (req, res) => {
  const p = readJSON('pricing.json');
  // Never expose MathPix or Overleaf credentials to client
  const { mpAppId:_, mpAppKey:__, overleafToken:___, ...safe } = p;
  res.json(safe);
});
app.post('/api/pricing', (req, res) => {
  const existing = readJSON('pricing.json');
  // Preserve stored MathPix creds; only admin can update them via /api/pricing/mathpix
  const { mpAppId, mpAppKey, ...rest } = req.body;
  writeJSON('pricing.json', { ...existing, ...rest });
  res.json({ ok: true });
});
// Admin sets MathPix credentials server-side (hidden from managers)
app.post('/api/pricing/mathpix', (req, res) => {
  const { mpAppId, mpAppKey } = req.body;
  const p = readJSON('pricing.json');
  if (mpAppId !== undefined) p.mpAppId = mpAppId;
  if (mpAppKey !== undefined) p.mpAppKey = mpAppKey;
  writeJSON('pricing.json', p);
  res.json({ ok: true, hasCredentials: !!(p.mpAppId && p.mpAppKey) });
});
// Check if MathPix credentials are configured (returns boolean only)
app.get('/api/pricing/mathpix', (req, res) => {
  const p = readJSON('pricing.json');
  res.json({ hasCredentials: !!(p.mpAppId && p.mpAppKey) });
});

// ── MANAGER PAYMENT REQUESTS ──────────────────────────────────────────────────
// Manager requests payout
app.post('/api/managers/:id/payment-request', (req, res) => {
  const users = readJSON('users.json');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Manager not found.' });
  const pricing = readJSON('pricing.json');
  const subs = readJSON('submissions.json');
  const completedSubs = subs.filter(s => s.assignedTo?.id === req.params.id && s.paid && s.status === 'done');
  const revenueHT = completedSubs.reduce((a,s) => a + (s.price||0), 0);
  const earned = Math.round(revenueHT * (pricing.managerRate||10) / 100);
  const alreadyPaid = users[idx].totalPaid || 0;
  const available = earned - alreadyPaid;
  const minPayout = pricing.minPayout || 5000;
  if (available < minPayout) return res.status(400).json({ error: `Minimum payout is ${pricing.currency} ${minPayout}. Available: ${pricing.currency} ${available}.` });
  // Record request
  if (!users[idx].paymentRequests) users[idx].paymentRequests = [];
  const request = { id: 'pr_'+Date.now(), amount: available, requestedAt: new Date().toISOString(), status: 'pending' };
  users[idx].paymentRequests.unshift(request);
  writeJSON('users.json', users);
  // Notify admin
  const notifs = readJSON('notifications.json');
  notifs.unshift({ id:'n_'+Date.now(), type:'payment_request',
    to:'admin@maktech.co.uk', toName:'Admin',
    subject:`💸 Payment request from ${users[idx].name}`,
    body:`${users[idx].tagName||users[idx].name} is requesting payment of ${pricing.currency} ${available}.\n\nEarned: ${pricing.currency} ${earned} · Already paid: ${pricing.currency} ${alreadyPaid}`,
    managerId: req.params.id, managerName: users[idx].name,
    sentAt: new Date().toISOString(), read: false });
  writeJSON('notifications.json', notifs.slice(0,200));
  res.json({ ok: true, available, request });
});

// Admin pays manager
app.patch('/api/managers/:id/pay', (req, res) => {
  const { amount } = req.body;
  if (!amount || isNaN(amount)) return res.status(400).json({ error: 'Invalid amount.' });
  const amt = Number(amount);
  const users = readJSON('users.json');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Manager not found.' });
  const pricing = readJSON('pricing.json');
  const mgr = users[idx];

  mgr.totalPaid = (mgr.totalPaid || 0) + amt;
  // Mark pending requests as paid
  if (mgr.paymentRequests) {
    mgr.paymentRequests = mgr.paymentRequests.map(r =>
      r.status === 'pending' ? { ...r, status: 'paid', paidAt: new Date().toISOString(), paidAmount: amt } : r
    );
  }
  writeJSON('users.json', users);

  // Persist withdrawal to withdrawals.json
  const wFile = 'withdrawals.json';
  const wPath = path.join(DATA, wFile);
  if (!fs.existsSync(wPath)) fs.writeFileSync(wPath, '[]');
  const withdrawals = readJSON(wFile);
  withdrawals.unshift({
    id: 'w_'+Date.now(),
    managerId: mgr.id,
    managerName: mgr.name,
    tagName: mgr.tagName || mgr.name,
    amount: amt,
    currency: pricing.currency,
    paidAt: new Date().toISOString()
  });
  writeJSON(wFile, withdrawals);

  // Notify manager
  const notifs = readJSON('notifications.json');
  notifs.unshift({
    id:'n_'+Date.now(), type:'payment_paid',
    to: mgr.id, toName: mgr.name,
    subject:`✅ Paiement de ${pricing.currency} ${amt} reçu.`,
    body:`L'admin vous a payé ${pricing.currency} ${amt}.\nTotal retiré à ce jour: ${pricing.currency} ${mgr.totalPaid}.\nMerci pour votre collaboration!`,
    sentAt: new Date().toISOString(), read: false
  });
  // Notify admin too (in withdrawal tab)
  notifs.unshift({
    id:'n_'+Date.now()+'_a', type:'withdrawal',
    to:'admin@maktech.co.uk', toName:'Admin',
    subject:`💸 Payment of ${pricing.currency} ${amt} to ${mgr.tagName||mgr.name}`,
    body:`You paid ${pricing.currency} ${amt} to ${mgr.name} (${mgr.tagName||'no tag'}).\nTotal paid to this manager: ${pricing.currency} ${mgr.totalPaid}.`,
    managerId: mgr.id, managerName: mgr.name, amount: amt,
    sentAt: new Date().toISOString(), read: false
  });
  writeJSON('notifications.json', notifs.slice(0,300));

  res.json({ ok: true, totalPaid: mgr.totalPaid });
});

// Get withdrawal history
app.get('/api/withdrawals', (req, res) => {
  const wPath = path.join(DATA, 'withdrawals.json');
  if (!fs.existsSync(wPath)) return res.json([]);
  res.json(readJSON('withdrawals.json'));
});

// ── OVERLEAF CREDENTIALS (admin stores, managers use invisibly) ────────────────
app.post('/api/pricing/overleaf', (req, res) => {
  const { overleafToken } = req.body;
  const p = readJSON('pricing.json');
  if (overleafToken !== undefined) p.overleafToken = overleafToken;
  writeJSON('pricing.json', p);
  res.json({ ok: true, hasToken: !!p.overleafToken });
});
app.get('/api/pricing/overleaf', (req, res) => {
  const p = readJSON('pricing.json');
  res.json({ hasToken: !!p.overleafToken });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  voTex Platform running at http://localhost:${PORT}`);
  console.log(`📁  Uploads : ${UPLOADS}`);
  console.log(`🔑  Admin   : admin@maktech.co.uk\n`);
});
