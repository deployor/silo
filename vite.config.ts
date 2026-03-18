import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	build: {
		outDir: "src/assets/react",
		emptyOutDir: true,
		cssCodeSplit: false,
		rollupOptions: {
			input: resolve(__dirname, "src/frontend/app/main.tsx"),
			output: {
				entryFileNames: "app.js",
				assetFileNames: (assetInfo) => {
					if (assetInfo.name?.endsWith(".css")) return "app.css";
					return "assets/[name]-[hash][extname]";
				},
			},
		},
	},
});
