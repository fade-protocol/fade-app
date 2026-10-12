import "./shims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installStaleDeployReload } from "./lib/staleDeploy";
import "./styles.css";

installStaleDeployReload();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
