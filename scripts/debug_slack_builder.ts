import { Section } from "slack-block-builder";

const section = Section({ text: "Hello" });
console.log("Section keys:", Object.keys(section));
console.log("Section prototype:", Object.getPrototypeOf(section));

try {
	// @ts-expect-error
	console.log("buildToObject:", section.buildToObject());
} catch (e) {
	console.log("buildToObject error:", e.message);
}

try {
	// @ts-expect-error
	console.log("buildToJSON:", section.buildToJSON());
} catch (e) {
	console.log("buildToJSON error:", e.message);
}
