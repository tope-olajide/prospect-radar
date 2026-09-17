import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./index.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL;
const root = createRoot(document.getElementById("root")!);

if (convexUrl) {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <ConvexProvider client={new ConvexReactClient(convexUrl)}>
          <App backendConnected />
        </ConvexProvider>
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
