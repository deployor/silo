import Handlebars from "handlebars";
import { config } from "../config";

const templateCache = new Map<string, Handlebars.TemplateDelegate>();

interface RenderOptions {
	layout?: string | boolean;
}

export async function render(
	templateName: string,
	data: any = {},
	options: RenderOptions = { layout: "main" },
): Promise<string> {
	const isDev = process.env.NODE_ENV !== "production";

	// Initialize sections container
	if (!data.sections) {
		data.sections = {};
	}

	// Helper to compile a template
	const compile = async (path: string) => {
		if (!isDev && templateCache.has(path)) {
			return templateCache.get(path)!;
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
		// 1. Render the view
		// Assume templates are in src/views/
		const templatePath = `src/views/${templateName}.hbs`;
		const viewTemplate = await compile(templatePath);
		const body = viewTemplate({ ...data, config });

		// 2. If no layout, return body
		if (options.layout === false) {
			return body;
		}

		// 3. Render the layout
		const layoutName =
			typeof options.layout === "string" ? options.layout : "main";
		const layoutPath = `src/views/layouts/${layoutName}.hbs`;
		const layoutTemplate = await compile(layoutPath);

		return layoutTemplate({
			...data,
			config,
			body,
		});
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

Handlebars.registerHelper("section", function (this: any, name, options) {
	if (!this.sections) this.sections = {};
	this.sections[name] = options.fn(this);
	return null;
});
