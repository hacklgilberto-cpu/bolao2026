'use strict';
// ═══════════════════════════════════════════════════════════════
// CLOUD FUNCTIONS — Bolão Copa 2026
//
// Deploy:  firebase deploy --only functions,firestore
//
// No env vars needed — PayPal payments are confirmed manually
// by the organiser in the admin panel.
// ═══════════════════════════════════════════════════════════════
const functions = require('firebase-functions');
const admin     = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// ───────────────────────────────────────────────────────────────
// 1. ON MATCH RESULT WRITTEN
//    Firestore trigger: matches/{matchId}
//    Fires when the admin saves a score (h / a).
//    Scores every prediction for that match and updates each
//    user's totalPts counter automatically.
// ───────────────────────────────────────────────────────────────
exports.onMatchResultWritten = functions.firestore
  .document('matches/{matchId}')
  .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    if (!after || !after.result) return null;

    // Skip if result didn't change
    const before = change.before.exists ? change.before.data() : {};
    if (
      before.result &&
      before.result.h === after.result.h &&
      before.result.a === after.result.a
    ) return null;

    const { matchId } = context.params;
    const result = after.result; // { h, a }

    const predsSnap = await db
      .collection('predictions')
      .where('matchId', '==', matchId)
      .get();

    if (predsSnap.empty) {
      console.log(`No predictions for match ${matchId}`);
      return null;
    }

    const batch = db.batch();

    predsSnap.forEach(predDoc => {
      const pred    = predDoc.data();
      const pts     = calcPts(pred, result);
      const prevPts = pred.pts || 0;
      const diff    = pts - prevPts;

      batch.update(predDoc.ref, {
        pts,
        result,
        scoredAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (diff !== 0) {
        batch.update(db.collection('users').doc(pred.uid), {
          totalPts: admin.firestore.FieldValue.increment(diff)
        });
      }
    });

    await batch.commit();
    console.log(`Scored ${predsSnap.size} predictions for match ${matchId} — ${result.h}:${result.a}`);
    return null;
  });

// ── Scoring: 5 exact / 3 correct outcome / 1 one side right / 0 miss ──
function calcPts(pred, result) {
  if (pred.h == null || pred.a == null) return 0;
  if (pred.h === result.h && pred.a === result.a) return 5;
  const outcome = (h, a) => h > a ? 'W' : h < a ? 'L' : 'D';
  if (outcome(pred.h, pred.a) === outcome(result.h, result.a)) return 3;
  if (pred.h === result.h || pred.a === result.a) return 1;
  return 0;
}

// ───────────────────────────────────────────────────────────────
// 2. APPROVE PLAYER  (HTTP Callable — admin only)
//    Organiser confirms PayPal Pool payment manually, then calls
//    this from the admin panel.
//    Sets users/{uid}.status = 'active', which triggers the
//    real-time listener (listenForApproval) on the player's tab.
// ───────────────────────────────────────────────────────────────
exports.approvePlayer = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in');
  }

  const adminDoc = await db.collection('admins').doc(context.auth.uid).get();
  if (!adminDoc.exists) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }

  const { uid, roundIds } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'uid is required');
  }

  await db.collection('users').doc(uid).update({
    status:          'active',
    activeRounds:    roundIds || [],
    pendingApproval: false,
    approvedAt:      admin.firestore.FieldValue.serverTimestamp(),
    approvedBy:      context.auth.uid
  });

  console.log(`Admin ${context.auth.uid} approved player ${uid}`);
  return { success: true };
});
