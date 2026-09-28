import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { startPwa } from "./pwa";
import { startTheme } from "./theme";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchInterval: 30_000, staleTime: 10_000 },
  },
});

startTheme();
startPwa(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
