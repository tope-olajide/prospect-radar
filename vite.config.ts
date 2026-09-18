import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // The convex-test suites drain the scheduler in tight loops and Vitest runs
    // the files across parallel workers. Under that load a single case can blow
    // past the 5s default even though it is perfectly healthy, which made the
    // suite intermittently red. Keep the budget generous so a green suite stays
    // green for anyone who clones the repo.
    testTimeout: 20000,
  },
});
