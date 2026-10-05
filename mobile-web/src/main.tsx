// First: storage keys an older build wrote move to their current names
// before any module reads them (a no-op while the app's name is unchanged).
import "../../src/lib/brandMigrationBoot";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./style.css";
import "./themes.css";
import { applyPhoneTheme } from "./theme";

applyPhoneTheme();
if ("serviceWorker" in navigator) window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);

