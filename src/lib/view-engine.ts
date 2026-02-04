import Handlebars from "handlebars";
import { config } from "../config";
import { formatBytes } from "./format";

const templateCache = new Map<string, Handlebars.TemplateDelegate>();

interface RenderOptions {
	layout?: string | boolean;
}

interface ViewData extends Record<string, unknown> {
	sections?: Record<string, unknown>;
}

function stripHtmlComments(html: string): string {
	// Remove HTML comments from the final HTML sent to the client.
	// Keep IE conditional comments just in case (rare, but safe).
	return html.replace(/<!--(?!\[if)([\s\S]*?)-->/g, "");
}

export async function render(
	templateName: string,
	viewData: ViewData = {},
	options: RenderOptions = { layout: "main" },
): Promise<string> {
	const isDev = process.env.NODE_ENV !== "production";

	// Initialize sections container
	if (!viewData.sections) {
		viewData.sections = {};
	}

	// Helper to compile a template
	const compile = async (path: string) => {
		if (!isDev && templateCache.has(path)) {
			return templateCache.get(path) as Handlebars.TemplateDelegate;
		}
		const file = Bun.file(path);
		const text = await file.text();
		const template = Handlebars.compile(text);
		if (!isDev) {
			templateCache.set(path, template);
		}
		return template;
	};

	try {
		const templatePath = `src/views/${templateName}.hbs`;
		const viewTemplate = await compile(templatePath);
		const body = viewTemplate({ ...viewData, config });

		if (options.layout === false) {
			return isDev ? body : stripHtmlComments(body);
		}

		const layoutName =
			typeof options.layout === "string" ? options.layout : "main";
		const layoutPath = `src/views/layouts/${layoutName}.hbs`;
		const layoutTemplate = await compile(layoutPath);

		const html = layoutTemplate({
			...viewData,
			...viewData.sections,
			config,
			body,
		});

		// Strip client-visible HTML comments in production.
		return isDev ? html : stripHtmlComments(html);
	} catch (e) {
		console.error(`Failed to render template: ${templateName}`, e);
		throw e;
	}
}

// Register common helpers
Handlebars.registerHelper("json", (context) => {
	return JSON.stringify(context);
});

Handlebars.registerHelper("eq", (a, b) => {
	return a === b;
});

Handlebars.registerHelper("gt", (a, b) => {
	return a > b;
});

Handlebars.registerHelper("section", function (this: ViewData, name, options) {
	if (!this.sections) this.sections = {};
	this.sections[name] = options.fn(this);
	return null;
});

Handlebars.registerHelper("formatDate", (date) => {
	if (!date) return "";
	return new Date(date).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
});

Handlebars.registerHelper("formatBytes", (bytes) => {
	return formatBytes(bytes);
});

Handlebars.registerHelper("lt", (a, b) => {
	return a < b;
});

Handlebars.registerHelper("add", (a, b) => {
	return Number(a) + Number(b);
});

Handlebars.registerHelper("subtract", (a, b) => {
	return Number(a) - Number(b);
});

Handlebars.registerHelper("or", (a, b) => {
	return a || b;
});
