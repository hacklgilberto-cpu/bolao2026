// ═══════════════════════════════════════════════════════════════
// FIREBASE CONFIG — Bolão Copa 2026
// Replace the values below with your project from Firebase Console
// ═══════════════════════════════════════════════════════════════
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBaqATdq-C85-sx-xjIkTr-cdn_z4O8Agw",
  authDomain: "wc2026-40589.firebaseapp.com",
  projectId: "wc2026-40589",
  storageBucket: "wc2026-40589.firebasestorage.app",
  messagingSenderId: "11909315711",
  appId: "1:11909315711:web:4e047c633d59f6d6b5134a"
};

firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db   = firebase.firestore();

// ═══════════════════════════════════════════════════════════════
// GOOGLE SIGN-IN  — replaces the mock doGoogle() in the HTML
// ═══════════════════════════════════════════════════════════════
async function doGoogle() {
  const btn = document.getElementById('googleBtn');
  const txt = document.getElementById('googleTxt');
  btn.disabled = true;
  txt.textContent = LANG === 'pt' ? 'Entrando…' : 'Signing in…';

  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const result   = await auth.signInWithPopup(provider);
    const user     = result.user;

    googleDone      = true;
    googleUserName  = user.displayName || user.email;
    googleUserEmail = user.email;

    // Create / update user doc — status starts as 'pending' (organiser approves after payment)
    await db.collection('users').doc(user.uid).set({
      uid:       user.uid,
      name:      user.displayName,
      email:     user.email,
      photoURL:  user.photoURL || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      status:    'pending'
    }, { merge: true });

    txt.textContent = '✓ ' + user.email;
    btn.style.opacity = '.6';
    document.getElementById('signedInEmail').textContent = user.email;
    document.getElementById('signedInRow').style.display = 'block';
    toast(LANG === 'pt' ? 'Login com Google ✓' : 'Google sign-in ✓', 'green');

    // Automatically activate once organiser approves in Firestore
    listenForApproval(user.uid, user.displayName);

  } catch (err) {
    console.error('Google sign-in:', err);
    btn.disabled = false;
    btn.style.opacity = '';
    txt.textContent = LANG === 'pt' ? 'G  Entrar com Google' : 'G  Continue with Google';
    if (err.code !== 'auth/popup-closed-by-user') {
      toast(LANG === 'pt' ? 'Erro no login' : 'Sign-in failed', 'red');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// REAL-TIME APPROVAL LISTENER
// Fires activatePlayer() the moment organiser sets status:'active'
// ═══════════════════════════════════════════════════════════════
function listenForApproval(uid, name) {
  db.collection('users').doc(uid).onSnapshot(snap => {
    const data = snap.data();
    if (data && data.status === 'active') {
      activatePlayer(data.name || name, data.email || googleUserEmail);
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// PERSIST PREDICTION TO FIRESTORE
// Called alongside the existing local savePred() in the HTML
// ═══════════════════════════════════════════════════════════════
async function savePredFirestore(matchId, h, a) {
  const user = auth.currentUser;
  if (!user) return;
  try {
    await db.collection('predictions').doc(`${user.uid}_${matchId}`).set({
      uid:     user.uid,
      matchId: String(matchId),
      h, a,
      savedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error('savePred:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
// SAVE MATCH RESULT TO FIRESTORE
// Writing matches/{id}.result triggers the Cloud Function that
// scores every prediction for that match automatically.
// ═══════════════════════════════════════════════════════════════
async function saveResultFirestore(matchId, h, a) {
  const user = auth.currentUser;
  if (!user) { console.warn('saveResult: not authenticated'); return; }
  try {
    await db.collection('matches').doc(String(matchId)).set({
      result:    { h, a },
      updatedBy: user.uid,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.error('saveResult:', err);
    toast('Firestore error — result saved locally only', 'red');
  }
}

// ═══════════════════════════════════════════════════════════════
// APPROVE PLAYER  — called from admin panel
// Writing status:'active' triggers listenForApproval() on the
// player's browser tab in real-time.
// ═══════════════════════════════════════════════════════════════
async function approvePlayerFirestore(uid, roundIds) {
  try {
    await db.collection('users').doc(uid).update({
      status:      'active',
      activeRounds: roundIds || [],
      approvedAt:  firebase.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (err) {
    console.error('approvePlayer:', err);
    toast('Firestore error', 'red');
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// LOAD PLAYERS FOR ADMIN PANEL (live query)
// ═══════════════════════════════════════════════════════════════
async function loadPlayersForAdmin() {
  const snap = await db.collection('users').get();
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

// ═══════════════════════════════════════════════════════════════
// AUTH STATE OBSERVER
// Restores session on page reload
// ═══════════════════════════════════════════════════════════════
auth.onAuthStateChanged(user => {
  if (!user) return;
  googleDone      = true;
  googleUserName  = user.displayName || user.email;
  googleUserEmail = user.email;

  const btn = document.getElementById('googleBtn');
  const txt = document.getElementById('googleTxt');
  if (btn && txt) {
    txt.textContent   = '✓ ' + user.email;
    btn.disabled      = true;
    btn.style.opacity = '.6';
  }
  const emailEl = document.getElementById('signedInEmail');
  const rowEl   = document.getElementById('signedInRow');
  if (emailEl) emailEl.textContent    = user.email;
  if (rowEl)   rowEl.style.display    = 'block';

  // Re-attach approval listener on reload
  listenForApproval(user.uid, user.displayName);

  // Restore S.user if status is active
  db.collection('users').doc(user.uid).get().then(snap => {
    const data = snap.data();
    if (data && data.status === 'active' && !S.user) {
      activatePlayer(data.name || user.displayName, data.email);
    }
  });
});
