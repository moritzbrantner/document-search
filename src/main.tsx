import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import App from "./App";
import { initializeDemoCorpus } from "./demo/demoCorpus";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

void initializeDemoCorpus()
  .then(() => queryClient.invalidateQueries({ queryKey: ["documents"] }))
  .catch(() => undefined);
