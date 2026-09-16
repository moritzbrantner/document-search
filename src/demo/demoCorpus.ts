import { extractHtmlDocument } from "../domain/htmlExtraction";
import type { ExtractedDocument, HtmlDocumentInput } from "../domain/types";
import { listDocuments, putDocument } from "../storage/indexedDbStore";

export const DEMO_DOCUMENT_INPUTS: readonly HtmlDocumentInput[] = [
  {
    id: "demo-local-first-search",
    title: "Local-first search architecture",
    sourceUri: "demo://local-first-search.html",
    importedAt: "2026-09-16T08:00:00.000Z",
    html: `
      <article>
        <h1>Local-first search architecture</h1>
        <p>A local-first document search tool keeps the primary corpus in the browser instead of requiring a hosted search service. Imported documents can be parsed, normalized, and stored in IndexedDB so that the same corpus is available after a reload.</p>
        <h2>Privacy and resilience</h2>
        <p>Search can remain useful without a network connection. Keeping raw documents and the derived search input on the device also reduces how much private material needs to leave the browser.</p>
        <h2>Authority boundaries</h2>
        <p>The product layer should own document ingestion and corpus interaction, while the indexing library owns retrieval, ranking, phrase constraints, and scoring. That boundary prevents a second search engine from appearing in user-interface code.</p>
      </article>
    `,
  },
  {
    id: "demo-urban-tree-canopy",
    title: "Urban tree canopy and summer heat",
    sourceUri: "demo://urban-tree-canopy.html",
    importedAt: "2026-09-16T08:01:00.000Z",
    html: `
      <article>
        <h1>Urban tree canopy and summer heat</h1>
        <p>Street trees can reduce heat exposure by shading pavement and buildings and by moving water through leaves. The effect is strongest where canopy is continuous enough to shade walking routes, playgrounds, and other places used during the hottest hours.</p>
        <h2>Planning for useful shade</h2>
        <p>A planting program should consider crown size, soil volume, drought tolerance, maintenance, and the location of vulnerable residents. A large number of poorly placed trees can deliver less useful shade than a smaller, connected canopy along daily routes.</p>
        <h2>Long-term measurement</h2>
        <p>Useful evaluation combines canopy maps with surface temperature, pedestrian comfort, tree survival, and maintenance records. Because trees mature slowly, the strongest results come from repeated measurements rather than a single summer snapshot.</p>
      </article>
    `,
  },
  {
    id: "demo-sourdough-fermentation",
    title: "Sourdough fermentation notes",
    sourceUri: "demo://sourdough-fermentation.html",
    importedAt: "2026-09-16T08:02:00.000Z",
    html: `
      <article>
        <h1>Sourdough fermentation notes</h1>
        <p>Fermentation speed depends on starter activity, dough temperature, inoculation, flour choice, and time. A warm dough usually ferments faster, while a cooler dough gives the baker a longer window before shaping.</p>
        <h2>Reading the dough</h2>
        <p>Volume increase is useful, but it should be read together with bubbles, elasticity, surface shape, and how the dough responds to handling. Fixed clock times are less reliable when room temperature or starter strength changes.</p>
        <h2>Repeatable batches</h2>
        <p>Record flour percentages, water temperature, dough temperature, bulk duration, proof duration, and the final result. A small log makes it easier to change one variable at a time and learn which adjustments improve flavor and structure.</p>
      </article>
    `,
  },
  {
    id: "demo-compiler-optimization",
    title: "Compiler optimization pass design",
    sourceUri: "demo://compiler-optimization.html",
    importedAt: "2026-09-16T08:03:00.000Z",
    html: `
      <article>
        <h1>Compiler optimization pass design</h1>
        <p>An optimization pass should make its preconditions and preserved properties explicit. This matters most when several passes share an intermediate representation and each pass assumes that previous transformations maintained control-flow or type invariants.</p>
        <h2>Avoid unnecessary materialization</h2>
        <p>Performance problems often appear when a clean abstraction repeatedly copies large graphs or rebuilds derived analysis. Prefer stable ownership of the intermediate representation and invalidate only the analyses affected by a transformation.</p>
        <h2>Measure the pipeline</h2>
        <p>Useful benchmarks separate parsing, analysis, transformation, code generation, and serialization. Whole-program latency is important, but phase-level evidence is what reveals duplicated work and multiplicative costs.</p>
      </article>
    `,
  },
  {
    id: "demo-wetland-restoration",
    title: "Coastal wetland restoration field brief",
    sourceUri: "demo://wetland-restoration.html",
    importedAt: "2026-09-16T08:04:00.000Z",
    html: `
      <article>
        <h1>Coastal wetland restoration field brief</h1>
        <p>Restoring a tidal wetland is not only a planting exercise. Hydrology, sediment movement, salinity, elevation, and connections to surrounding habitat determine whether vegetation can establish and whether nursery habitat remains available to fish and birds.</p>
        <h2>Restore processes first</h2>
        <p>Where possible, projects reopen tidal exchange and repair water movement before relying on intensive planting. Natural recruitment can then reveal which species match the restored elevation and salinity regime.</p>
        <h2>Adaptive monitoring</h2>
        <p>Teams can track vegetation cover, channel shape, elevation, water levels, and wildlife use over several seasons. Monitoring should feed back into maintenance decisions so that blocked channels, invasive plants, or erosion are addressed before they dominate the site.</p>
      </article>
    `,
  },
];

export function createDemoDocuments(): ExtractedDocument[] {
  return DEMO_DOCUMENT_INPUTS.map((input) => extractHtmlDocument(input));
}

export async function seedDemoCorpusIfEmpty(): Promise<boolean> {
  const existingDocuments = await listDocuments();
  if (existingDocuments.length > 0) {
    return false;
  }

  for (const document of createDemoDocuments()) {
    await putDocument(document);
  }
  return true;
}
