import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
    publicDir: false,
    build: {
        outDir: "dist/lib",
        emptyOutDir: true,
        sourcemap: true,
        lib: {
            entry: resolve("src/index.ts"),
            name: "NixQuery",
            formats: ["es", "cjs"],
            fileName: (format) => (format === "cjs" ? "nix-query.cjs" : "nix-query.js"),
        },
        rollupOptions: {
            external: ["@deijose/nix-js"],
            output: {
                preserveModules: false,
                globals: {
                    "@deijose/nix-js": "NixJs",
                },
            },
        },
    },
});
