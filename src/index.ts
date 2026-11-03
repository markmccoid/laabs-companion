import { loadConfig } from "./config";
import { resolveLibraryRoots } from "./paths";
import { createCompanionServer } from "./server";

const main = async () => {
  const config = loadConfig();
  const realLibraryRoots = await resolveLibraryRoots(config.libraryRoots);
  const server = createCompanionServer(config, { realLibraryRoots });

  server.listen(config.port, config.host, () => {
    console.info(`laabs-companion listening on http://${config.host}:${config.port}${config.basePath}`);
    console.info(`Audiobookshelf: ${config.absInternalUrl}`);
    console.info(`Library roots: ${realLibraryRoots.join(", ")}`);
    config.pathMappings.forEach((mapping) =>
      console.info(`Path mapping: ${mapping.absPrefix} -> ${mapping.localPrefix}`),
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
