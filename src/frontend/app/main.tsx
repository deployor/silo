import React from "react";
import { createRoot } from "react-dom/client";
import type { AppBootstrap } from "../shared/types/app";
import { App } from "./App";
import "../../styles.css";
import "../styles.css";

const bootstrap: AppBootstrap = window.__SILO_APP__ ?? {
	page: "unknown",
	props: {},
};

const rootEl = document.getElementById("root");

if (rootEl) {
	createRoot(rootEl).render(
		<React.StrictMode>
			<App bootstrap={bootstrap} />
		</React.StrictMode>,
	);
}
