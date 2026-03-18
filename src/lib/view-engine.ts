import { renderReactDocument } from "./react-view-engine";

interface RenderOptions {
	layout?: string | boolean;
}

interface ViewData extends Record<string, unknown> {
	sections?: Record<string, unknown>;
}

export async function render(
	templateName: string,
	viewData: ViewData = {},
	options: RenderOptions = { layout: "main" },
): Promise<string> {
	return renderReactDocument(templateName, viewData, options);
}
