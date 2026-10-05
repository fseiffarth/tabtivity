import { useCallback, useEffect, useRef, useState } from "react";
import { MIN_NEW_PIN, configureLocalUnlock, localUnlockBiometricEnabled, localUnlockPinLength, maybeEnrollBiometric, platformBiometricAvailable, unlockLocal, unlockLocalBiometric, validPin } from "../localLock";
import { localFailureText } from "../connection";
import { isUntested } from "../../../src/lib/untested";
import { BrandHead } from "../components/BrandHead";
import { BUNDLE_VERSION } from "../buildInfo";
import { useT } from "../../../src/lib/i18n";

/** A ridge-arch fingerprint, drawn for this screen: open loops over a centre
 * stem, with the broken ridges on the right that make it read as a print
 * rather than a set of nested arches. Strokes take `currentColor`. */
function FingerprintIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.2 8.4A8.6 8.6 0 0 1 17.9 5.6" />
    <path d="M19.9 9.2A8.6 8.6 0 0 1 20.6 12.6V13.6" />
    <path d="M3.4 12.6A8.6 8.6 0 0 1 3.5 11.8" />
    <path d="M5.9 18.2V12.6A6.1 6.1 0 0 1 16.3 8.3" />
    <path d="M18 11.4 18.1 12.6V15.4" />
    <path d="M8.4 20.4V12.6A3.6 3.6 0 0 1 15.6 12.6V17.6" />
    <path d="M12 12.4V21" />
    <path d="M18.1 18.6V18.9" />
  </svg>;
}

/** How long the unlock flourish plays before the app takes over: the mark
 * flares and lifts away. None under reduced motion. */
const UNLOCK_FLOURISH_MS = 520;

function unlockFlourishMs(): number {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : UNLOCK_FLOURISH_MS;
}

export function LocalUnlock({ setup, onUnlocked }: { setup: boolean; onUnlocked: () => void }) {
  const t = useT();
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(null);
  /** null while the record is being read — the unlock form waits for it, so
   * the PIN field's autoFocus (which fires at mount only) can be withheld
   * when the fingerprint prompt is about to cover the screen. */
  const [biometricEnrolled, setBiometricEnrolled] = useState<boolean | null>(setup ? false : null);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [pinLength, setPinLength] = useState<number | null>(null);
  /** Set once an unlock succeeds: the screen plays its flourish, then hands over. */
  const [unlocked, setUnlocked] = useState(false);
  const attempt = useRef(0);
  const autoPrompted = useRef(false);
  /** The fingerprint request in flight, so "Use PIN instead" can withdraw it. */
  const biometricRequest = useRef<AbortController | null>(null);
  const pinInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    void platformBiometricAvailable().then(setBiometricAvailable).catch(() => setBiometricAvailable(false));
  }, []);
  useEffect(() => {
    if (!setup) void localUnlockPinLength().then(setPinLength).catch(() => setPinLength(null));
  }, [setup]);
  useEffect(() => {
    if (!setup) void localUnlockBiometricEnabled().then(setBiometricEnrolled).catch(() => setBiometricEnrolled(false));
  }, [setup]);
  const finish = useCallback(() => {
    setUnlocked(true);
    window.setTimeout(onUnlocked, unlockFlourishMs());
  }, [onUnlocked]);
  const unlockWithBiometric = () => {
    attempt.current += 1;
    const request = new AbortController();
    biometricRequest.current = request;
    setBiometricBusy(true);
    setError("");
    void unlockLocalBiometric(request.signal).then(maybeEnrollBiometric).then(finish).catch((reason) => {
      if (!request.signal.aborted) setError(localFailureText(reason));
    }).finally(() => setBiometricBusy(false));
  };
  /** The way out of the fingerprint wait: a sheet that never came up, or a
   * reader who would rather type, left the screen showing nothing but the
   * mark — the PIN field steps aside while the wait runs. */
  const usePinInstead = () => {
    biometricRequest.current?.abort();
    biometricRequest.current = null;
    setBiometricBusy(false);
    window.setTimeout(() => pinInput.current?.focus(), 0);
  };
  useEffect(() => {
    // Fingerprint is the default unlock: raise the OS sheet as the screen opens,
    // with no button in between. A browser that wants a user gesture (iOS
    // Safari) rejects quietly and the button below stays as the way in; the PIN
    // is always the fallback.
    if (setup || !biometricEnrolled) return;
    let disposed = false;
    const promptWhenReady = () => {
      if (disposed || autoPrompted.current) return;
      // WebAuthn refuses outright on a hidden or unfocused document, and that
      // is exactly the state this screen mounts in when the lock fires while
      // the app is in the background: spending the one attempt there left the
      // reader facing the button on their return. Wait for the app to actually
      // be in front of them, then ask.
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      autoPrompted.current = true;
      const request = new AbortController();
      biometricRequest.current = request;
      setBiometricBusy(true);
      // A rejection is not retried: a cancelled sheet hands focus straight back,
      // and re-asking on that would trap the reader in a prompt they closed.
      void unlockLocalBiometric(request.signal).then(maybeEnrollBiometric).then(() => { if (!disposed) finish(); }).catch(() => {}).finally(() => { if (!disposed) setBiometricBusy(false); });
    };
    promptWhenReady();
    document.addEventListener("visibilitychange", promptWhenReady);
    window.addEventListener("focus", promptWhenReady);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", promptWhenReady);
      window.removeEventListener("focus", promptWhenReady);
    };
  }, [biometricEnrolled, finish, setup]);
  const submit = () => {
    attempt.current += 1;
    setBusy(true);
    setError("");
    const action = setup
      ? pin !== confirm
        ? Promise.reject(new Error(t("mobile.lock.pinMismatch")))
        : configureLocalUnlock(pin)
      : unlockLocal(pin).then(maybeEnrollBiometric);
    void action.then(finish).catch((reason) => setError(localFailureText(reason))).finally(() => setBusy(false));
  };
  useEffect(() => {
    const currentAttempt = ++attempt.current;
    // Auto-submit only when the exact length is known. On a record saved before
    // `pinLength` existed, this fired at 4, 5 *and* 6 digits — three 210,000
    // round PBKDF2 runs and two "Incorrect PIN." flashes while still typing,
    // each one now also burning a failed-attempt slot.
    if (setup || pinLength === null || !validPin(pin) || pin.length !== pinLength) {
      setBusy(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setBusy(true);
      setError("");
      void unlockLocal(pin).then(maybeEnrollBiometric).then(() => {
        if (currentAttempt === attempt.current) finish();
      }).catch((reason) => {
        if (currentAttempt === attempt.current) setError(localFailureText(reason));
      }).finally(() => {
        if (currentAttempt === attempt.current) setBusy(false);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [finish, pin, pinLength, setup]);
  // Android's fingerprint sheet covers the lower part of the screen and no page
  // can restyle it, so while it is up this screen becomes the branded half
  // above it: the form steps aside, the mark lifts into view with its rings
  // turning, and one line says what the sheet is waiting for.
  const verifying = biometricBusy && !unlocked;
  const phase = unlocked ? " unlocked" : verifying ? " verifying" : "";
  const content = <>
    <BrandHead>{setup ? t("mobile.lock.secureTitle") : t("mobile.lock.lockedTitle")}{!setup && isUntested("mobile.link.silentResume") && <small className="untested"> {t("mobile.newTab.untested")}</small>}{!setup && isUntested("mobile.lock.homeSheet") && <small className="untested"> {t("mobile.newTab.untested")}</small>}{!setup && isUntested("mobile.lock.reloadGrace") && <small className="untested"> {t("mobile.newTab.untested")}</small>}</BrandHead>
    <p className="local-unlock-status" aria-live="polite">
      {unlocked ? t("mobile.lock.unlocked") : verifying ? t("mobile.lock.touchSensor") : ""}
      {verifying && isUntested("mobile.lock.brandedSheet") && <small className="untested"> {t("mobile.newTab.untested")}</small>}
    </p>
    {verifying && !setup && <button className="local-unlock-use-pin" onClick={usePinInstead}>
      {t("mobile.lock.usePin")}{isUntested("mobile.lock.pinInstead") && <small className="untested"> {t("mobile.newTab.untested")}</small>}
    </button>}
    {setup ? <>
      <p>{biometricAvailable === false
        ? t("mobile.lock.noBiometricSetup")
        : t("mobile.lock.setupHint")}</p>
      <label>{t("mobile.lock.newPin", { min: MIN_NEW_PIN })}<input className="code" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} /></label>
      <label>{t("mobile.lock.confirmPin")}<input className="code" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={confirm} onChange={(event) => setConfirm(event.target.value.replace(/\D/g, ""))} /></label>
    </> : biometricEnrolled === null ? null : <>
      <p>{biometricEnrolled
        ? t("mobile.lock.unlockEnrolled")
        : biometricAvailable
          ? t("mobile.lock.unlockWillEnroll")
          : t("mobile.lock.unlockPinOnly")}</p>
      {/* A missing fingerprint option must not read as a broken one. Some
        * phone browsers are built on the system WebView and expose no platform
        * authenticator at all, so the lock can only ever be the PIN there —
        * say which browsers do offer it rather than leaving it unexplained. */}
      {!biometricEnrolled && biometricAvailable === false && <p className="local-unlock-note">{t("mobile.lock.noBiometricNote")}</p>}
      {biometricEnrolled && <button className={`local-unlock-biometric${biometricBusy ? " waiting" : ""}`} disabled={biometricBusy} onClick={unlockWithBiometric}>
        <span className="local-unlock-print"><FingerprintIcon /></span>
        <span>{biometricBusy ? t("mobile.lock.waitingDevice") : t("mobile.lock.unlockFingerprint")}</span>
      </button>}
      <label>{t("mobile.lock.pin")}<input ref={pinInput} className="code" type="password" inputMode="numeric" autoComplete="current-password" autoFocus={!biometricEnrolled} maxLength={pinLength ?? 12} value={pin} onChange={(event) => {
        const next = event.target.value.replace(/\D/g, "");
        setPin(pinLength === null ? next : next.slice(0, pinLength));
      }} /></label>
    </>}
    {error && <p className="error">{error}</p>}
    {setup
      ? <button className="primary" disabled={busy || !validPin(pin) || pin.length < MIN_NEW_PIN || pin !== confirm} onClick={submit}>
          {busy ? t("mobile.pair.securing") : biometricAvailable === false ? t("mobile.lock.setPin") : t("mobile.lock.setPinVerify")}
        </button>
      : biometricEnrolled !== null && pinLength === null && <button className="primary" disabled={busy || !validPin(pin)} onClick={submit}>
          {busy ? t("mobile.lock.checking") : t("mobile.lock.unlock")}
        </button>}
    <p className="local-unlock-note">{t("mobile.lock.note")}</p>
    <p className="splash-version">{t("mobile.title")} {BUNDLE_VERSION}{isUntested("mobile.lock.version") && <small className="untested"> {t("mobile.newTab.untested")}</small>}</p>
  </>;
  // Setup runs once, right after pairing, with no project data to stand
  // behind it yet — its own full screen. The lock met on every later cold
  // open or idle timeout rises as a sheet over the Home screen's shell
  // instead, so the reader lands somewhere that already looks like where they
  // are going rather than a screen unto itself.
  if (setup) return <main className={`pair screen brand-screen local-unlock${phase}`}>{content}</main>;
  return <div className={`sheet-backdrop lock-sheet-backdrop${phase}`} role="presentation">
    <section className={`option-sheet brand-screen local-unlock-sheet local-unlock${phase}`} role="dialog" aria-modal="true" aria-label={t("mobile.lock.lockedTitle")}>
      <span className="sheet-grip" aria-hidden="true" />
      {content}
    </section>
  </div>;
}
