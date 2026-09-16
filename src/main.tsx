import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import App from "./App";
import { seedDemoCorpusIfEmpty } from "./demo/demoCorpus";

const queryClient = new QueryClient();

void bootstrap();

async function bootstrap() {
  await seedDemoCorpusIfEmpty().catch(() => false);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
