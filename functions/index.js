'use strict';
// ═══════════════════════════════════════════════════════════════
// CLOUD FUNCTIONS — Bolão Copa 2026
//
// Deploy:  firebase deploy --only functions
// Config:  firebase functions:config:set paypal.client_id="..." \
//                                        paypal.client_secret="..." \
//                                        paypal.sandbox="true"
// ═══════════════════════════════════════════════════════════════
const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const fetch     = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

// ── PayPal base URL (sandbox vs live) ───────────────────────────
const PAYPAL_BASE = () => {
  const cfg = functions.config().paypal || {};
  return cfg.sandbox === 'true'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
};

// ───────────────────────────────────────────────────────────────
// 1. ON MATCH RESULT WRITTEN
//    Firestore trigger: matches/{matchId}
//    Fires when an admin saves a match score (h / a).
//    Loops over every prediction for that match, calculates points,
//    and updates prediction docs + each user's totalPts counter.
// ───────────────────────────────────────────────────────────────
exports.onMatchResultWritten = functions.firestore
  .document('matches/{matchId}')
  .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    // Only act when a result is present
    if (!after || !after.result) return null;

    // Skip if result didn't actually change
    const before = change.before.exists ? change.before.data() : {};
    if (
      before.result &&
      before.result.h === after.result.h &&
      before.result.a === after.result.a
    ) return null;

    const { matchId } = context.params;
    const result = after.result; // { h, a }

    // Fetch all predictions for this match
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
      const pred = predDoc.data();
      const pts  = calcPts(pred, result);

      // Update the prediction document with the awarded points
      batch.update(predDoc.ref, {
        pts,
        result,
        scoredAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Read previous pts for this match (0 if first time) and diff
      const prevPts = pred.pts || 0;
      const diff    = pts - prevPts;
      if (diff !== 0) {
        batch.update(db.collection('users').doc(pred.uid), {
          totalPts: admin.firestore.FieldValue.increment(diff)
        });
      }
    });

    await batch.commit();
    console.log(`Scored ${predsSnap.size} predictions for match ${matchId} — result ${result.h}:${result.a}`);
    return null;
  });

// ── Scoring helper ───────────────────────────────────────────────
function calcPts(pred, result) {
  if (pred.h == null || pred.a == null) return 0;
  if (pred.h === result.h && pred.a === result.a) return 5;       // exact score
  const outcome = (h, a) => h > a ? 'W' : h < a ? 'L' : 'D';
  if (outcome(pred.h, pred.a) === outcome(result.h, result.a)) return 3; // correct winner/draw
  if (pred.h === result.h || pred.a === result.a) return 1;        // one side correct
  return 0;
}

// ───────────────────────────────────────────────────────────────
// 2. PAYPAL CAPTURE ORDER  (HTTP Callable)
//    Called from the browser immediately after PayPal's onApprove.
//    Captures the order server-side (safe from tampering), then
//    writes to payments/ — which triggers onPaymentCreated below.
// ───────────────────────────────────────────────────────────────
exports.capturePaypalOrder = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in');
  }

  const { orderID, roundIds } = data;
  if (!orderID) {
    throw new functions.https.HttpsError('invalid-argument', 'orderID is required');
  }

  // 1. Get PayPal access token
  const accessToken = await getPaypalAccessToken();

  // 2. Capture the order
  const captureRes = await fetch(
    `${PAYPAL_BASE()}/v2/checkout/orders/${orderID}/capture`,
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    }
  );
  const order = await captureRes.json();

  if (order.status !== 'COMPLETED') {
    console.error('PayPal capture failed:', JSON.stringify(order));
    throw new functions.https.HttpsError('aborted', `Payment not completed: ${order.status}`);
  }

  const payer   = order.payer;
  const capture = order.purchase_units[0].payments.captures[0];
  const amount  = parseFloat(capture.amount.value);

  // 3. Write to payments/ — triggers onPaymentCreated
  const payRef = await db.collection('payments').add({
    orderID,
    captureID:   capture.id,
    uid:         context.auth.uid,
    payerName:   `${payer.name.given_name} ${payer.name.surname}`,
    payerEmail:  payer.email_address,
    roundIds:    roundIds || [],
    amount,
    currency:    capture.amount.currency_code,
    status:      'captured',
    createdAt:   admin.firestore.FieldValue.serverTimestamp()
  });

  console.log(`PayPal captured $${amount} for uid ${context.auth.uid} — payment ${payRef.id}`);
  return { success: true, paymentId: payRef.id, amount };
});

// ───────────────────────────────────────────────────────────────
// 3. ON PAYMENT CREATED
//    Firestore trigger: payments/{paymentId}
//    Marks the user as 'paid' so the admin panel highlights them,
//    and records which rounds they paid for.
// ───────────────────────────────────────────────────────────────
exports.onPaymentCreated = functions.firestore
  .document('payments/{paymentId}')
  .onCreate(async (snap, context) => {
    const payment = snap.data();
    if (!payment.uid) return null;

    await db.collection('users').doc(payment.uid).update({
      pendingApproval: true,
      paidRounds:      payment.roundIds || [],
      lastPayment: {
        id:        context.params.paymentId,
        amount:    payment.amount,
        currency:  payment.currency || 'USD',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }
    });

    console.log(`Payment ${context.params.paymentId} recorded — user ${payment.uid} pending approval`);
    return null;
  });

// ───────────────────────────────────────────────────────────────
// 4. APPROVE PLAYER  (HTTP Callable — admin only)
//    Sets users/{uid}.status = 'active'.
//    The player's browser tab is listening via listenForApproval()
//    and will automatically unlock predictions.
// ───────────────────────────────────────────────────────────────
exports.approvePlayer = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in');
  }

  // Only users listed in the 'admins' collection may approve
  const adminDoc = await db.collection('admins').doc(context.auth.uid).get();
  if (!adminDoc.exists) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }

  const { uid, roundIds } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'uid is required');
  }

  // Write to users/{uid} — triggers listenForApproval() on the player's browser
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

// ───────────────────────────────────────────────────────────────
// PAYPAL HELPERS
// ───────────────────────────────────────────────────────────────
async function getPaypalAccessToken() {
  const cfg      = functions.config().paypal || {};
  const clientId = cfg.client_id;
  const secret   = cfg.client_secret;

  if (!clientId || !secret) {
    throw new Error('PayPal credentials not configured. Run: firebase functions:config:set paypal.client_id="..." paypal.client_secret="..."');
  }

  const res = await fetch(`${PAYPAL_BASE()}/v1/oauth2/token`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`
    },
    body: 'grant_type=client_credentials'
  });

  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`PayPal auth failed: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}
