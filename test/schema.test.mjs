/* Defaults that matter enough to pin down: nothing else exercises
   DEFAULT_CONFIG directly, so a later edit could silently flip one back.
   Run: node test/schema.test.mjs */
import { DEFAULT_CONFIG } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== linking a fresh install defaults to QR ===');
{
  // A pairing code is the one WhatsApp has historically delivered less
  // reliably in practice - the symptom is a stuck "Waiting for pairing" with
  // nothing arriving on the phone. QR has no such failure mode, so it is the
  // default; pairing stays available as the fallback for a headless setup or
  // a phone that cannot be brought to the screen.
  ok(DEFAULT_CONFIG.whatsapp.loginMethod === 'qr', 'loginMethod defaults to qr, not pairing');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
