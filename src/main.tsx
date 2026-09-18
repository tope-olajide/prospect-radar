import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./index.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL;
const root = createRoot(document.getElementById("root")!);

if (convexUrl) {
  const convex = new ConvexReactClient(convexUrl);
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <ConvexAuthProvider client={convex}>
          <App backendConnected />
        </ConvexAuthProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <App backendConnected={false} />
    </StrictMode>,
  );
}
