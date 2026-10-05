import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { pair } from "../auth";
import { classifyUnavailable, describeUnavailable, localFailureText } from "../connection";
import { BrandHead } from "../components/BrandHead";
import { MIN_NEW_PIN, configureLocalUnlock, platformBiometricAvailable, validPin } from "../localLock";
import { appleTouchDevice } from "../platform";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

/**
 * What to say when pairing fails. The sidecar answers a bad or expired code
 * and its own rate limiter with a 400 carrying a bare code, which used to be
 * shown as `Error: invalid_pairing_code` — the one screen a new user sees
 * first, speaking in identifiers. Anything that is not about the code itself
 * is a reachability problem and gets the same machine-naming copy as the
 * splash.
 */
export function describePairFailure(reason: unknown, t: ReturnType<typeof useT>): string {
  if (reason instanceof ApiError) {
    if (reason.code === "invalid_pairing_code") return t("mobile.pair.invalidCode");
    if (reason.code === "too_many_attempts") return t("mobile.pair.tooManyAttempts");
  }
  const { title, hint } = describeUnavailable(classifyUnavailable(reason));
  return `${title} ${hint}`;
}

/** First pairing and local lock setup share one form. A failed biometric setup
 * leaves the phone paired, so a retry only finishes the lock: the one-time
 * pairing code has already been consumed. */
export function Pair({ setupLock, onDone }: { setupLock: boolean; onDone: () => void }) {
  const t = useT();
  const [code, setCode] = useState("");
  const [name, setName] = useState(() => appleTouchDevice() ?? t("mobile.pair.defaultName"));
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [stage, setStage] = useState<"idle" | "pairing" | "securing">("idle");
  const [paired, setPaired] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (setupLock) void platformBiometricAvailable().then(setBiometricAvailable).catch(() => setBiometricAvailable(false));
  }, [setupLock]);
  const submit = async () => {
    let nowPaired = paired;
    setError("");
    try {
      if (!nowPaired) {
        setStage("pairing");
        await pair(code, name);
        nowPaired = true;
        setPaired(true);
      }
      if (setupLock) {
        setStage("securing");
        await configureLocalUnlock(pin);
      }
      onDone();
    } catch (reason) {
      setError(nowPaired ? localFailureText(reason) : describePairFailure(reason, t));
    } finally {
      setStage("idle");
    }
  };
  return <main className="pair screen brand-screen">
    <BrandHead>{t("mobile.pair.title")}{isUntested("mobile.pair.singleScreen") && <small className="untested"> {t("mobile.newTab.untested")}</small>}</BrandHead>
    <p>{paired ? t("mobile.pair.finishHint") : t("mobile.pair.intro")}</p>
    {!paired && <>
      <label>{t("mobile.pair.deviceName")}<input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t("mobile.pair.code")}<input className="code" value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={8} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} /></label>
    </>}
    {setupLock && <>
      <p className="pair-lock-hint">{biometricAvailable === false ? t("mobile.pair.pinOnlyHint") : t("mobile.pair.pinHint")}</p>
      <label>{t("mobile.pair.pin")}<input className="code" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} /></label>
      <label>{t("mobile.pair.confirmPin")}<input className="code" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={confirm} onChange={(event) => setConfirm(event.target.value.replace(/\D/g, ""))} /></label>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    <button className="primary" disabled={stage !== "idle" || (!paired && (code.length !== 8 || !name.trim())) || (setupLock && (!validPin(pin) || pin.length < MIN_NEW_PIN || pin !== confirm))} onClick={() => void submit()}>
      {stage === "pairing" ? t("mobile.pair.pairing") : stage === "securing" ? t("mobile.pair.securing") : paired ? t("mobile.pair.finish") : setupLock ? t("mobile.pair.connectSecure") : t("mobile.pair.connect")}
    </button>
  </main>;
}
