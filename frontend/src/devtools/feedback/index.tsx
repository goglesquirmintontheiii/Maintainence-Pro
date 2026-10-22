// TEMPORARY (feedback capture, 0.4.2). Remove by 1.9.0 (2.0.0 at the latest). See ./README.md.
// Mounts the tool in its own root so the rest of the app knows nothing about it.

import { createRoot } from "react-dom/client";
import { FeedbackTool } from "./FeedbackTool";
import "./feedback.css";

const host = document.createElement("div");
host.setAttribute("data-mpro-feedback", "");
document.body.appendChild(host);
createRoot(host).render(<FeedbackTool />);
