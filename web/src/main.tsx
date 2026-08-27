import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

// StrictMode は開発時に effect を 2 回走らせる。
// PaymentForm はそれを前提に cleanup で card.destroy() を呼んでいるので、
// ここを外して問題を隠さないこと（外すと本番でのみ iframe が残るバグに気付けなくなる）。
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
