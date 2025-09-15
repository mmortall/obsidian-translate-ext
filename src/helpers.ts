
import { Editor, Notice, TFile} from "obsidian";
import type { ServiceOptions, TranslationResult } from "./handlers/types";
import t from "./l10n";
import type TranslatorPlugin from "./main";

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")  // заменить всё лишнее на "-"
    .replace(/^-+|-+$/g, "");     // убрать лишние "-"
}

function ensureTranslationKey(content: string, slug: string): string {
  // Матчим только самый первый блок frontmatter в начале файла
  const fmRegex = /^---\n([\s\S]*?)\n---/;

  if (fmRegex.test(content)) {
    return content.replace(fmRegex, (match, inner) => {
      // проверяем наличие translationKey именно внутри frontmatter
      if (/^translationKey:/m.test(inner)) {
        return `---\n${inner.replace(/^translationKey:.*/m, `translationKey: ${slug}`)}\n---`;
      } else {
        return `---\n${inner}\ntranslationKey: ${slug}\n---`;
      }
    });
  } else {
    // если frontmatter нет — создаём новый
    return `---\ntranslationKey: ${slug}\n---\n\n${content}`;
  }
}

/**
 * Helper function for translating a file, making a new file or replacing the original one with the translation.
 * @param plugin - The plugin instance (to get message_queue, global translator, etc.)
 * @param file - The file to translate
 * @param language_to - The language to translate to
 * @param replace_original - Whether to replace the original file with the translated file
 * @param options - Options for the translation service (e.g.: apply glossary)
 */
export async function translate_file(
	plugin: TranslatorPlugin,
	file: TFile | null,
	language_to: string,
	replace_original: boolean = false,
	options: ServiceOptions,
): Promise<TranslationResult> {
	if (!file)
		return { status_code: 400, message: "No file was selected" };

	let file_content = await plugin.app.vault.read(file);
	if (!file_content.trim())
		return { status_code: 400, message: "Selected file is empty" };

	if (!plugin.translator)
		return { status_code: 400, message: "No translation service available" };

	const paragraphs = file_content.split("\n\n");

	const translated_text = [];
	for (const paragraph of paragraphs) {
		// Paragraph only contains formatting
		if (paragraph.trim().length === 0)
			translated_text.push(paragraph);
		else {
			const output = await plugin.translator.translate(paragraph, "auto", language_to, options);
			if (output.status_code !== 200) {
				output.translation = translated_text.join("\n\n");
				return output;
			}

			translated_text.push(output.translation);
		}
	}

	let translated_file_content = translated_text.join("\n\n")

	if (replace_original)
		await plugin.app.vault.modify(file, translated_file_content);
	else {
		// Translate the filename as well, if possible
		const filename = file?.name.replace(/\.[^/.]+$/, "");

		const translation_result =
			(await plugin.translator.translate(filename, "auto", language_to, options));

		const filename_translation = translation_result.translation
		const detected_language = translation_result.detected_language || "unknown";
		const translated_filename = (!filename_translation || filename_translation === filename) ?
			`[${language_to}] ${filename}` : filename_translation;

		const translated_document_path = (file.parent!.path === "/" ? "" : file.parent!.path + "/") + `${language_to}/` +
			translated_filename + `.${language_to}.md`;

		let origin_document_new_path = '';
		if(file.parent!.path === "/") {
			origin_document_new_path = `${detected_language}/` + filename + `.${detected_language}.md`;
		} else if (file.parent!.path.endsWith(detected_language)) {
			origin_document_new_path = file.path; // No change
		} else {
			origin_document_new_path = (file.parent!.path === "/" ? "" : file.parent!.path + "/") + `${detected_language}/` +
				filename + `.${detected_language}.md`;
		}

		const translated_filename_slug = slugify(translated_filename);

		translated_file_content = ensureTranslationKey(translated_file_content, translated_filename_slug);
		file_content = ensureTranslationKey(file_content, translated_filename_slug);

		console.log("Detected language: " + detected_language);
		console.log("Filename translation: " + filename_translation);
		console.log("Translated filename: " + translated_filename);
		console.log("Translated document path: " + translated_document_path);

		// If translation of file already exists, replace it by new translation
		let existing_file = plugin.app.vault.getAbstractFileByPath(translated_document_path);
		if (existing_file && existing_file instanceof TFile)
			await plugin.app.vault.modify(existing_file, translated_file_content);
		else
			existing_file = await plugin.app.vault.create(translated_document_path, translated_file_content);

		// Move original document to folder with detected language
		if (file && !replace_original) {
			let origin_file = plugin.app.vault.getAbstractFileByPath(origin_document_new_path);
			if (!origin_file) {
				origin_file = await plugin.app.vault.create(origin_document_new_path, file_content);
			}	
			else if (origin_file instanceof TFile)
				await plugin.app.vault.modify(origin_file, file_content);
			//await plugin.app.vault.delete(file);
		}

		const leaf = plugin.app.workspace.getLeaf(false);
		plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
		await leaf.openFile(existing_file as TFile, { eState: { focus: true } });
	}

	return {
		status_code: 200,
		translation: translated_text.join("\n\n"),
	};
}

/**
 * Helper function for translating a selection, replacing the selection with the translation
 * @param plugin - The plugin instance (to get message_queue, global translator, etc.)
 * @param editor - Note editor instance
 * @param language_to - The language to translate to
 * @param options - Options for the translation service (e.g.: apply glossary)
 * @param handle_text - What to do with the translation (replace input, append below, copy to clipboard, ...)
 */
export async function translate_selection(
	plugin: TranslatorPlugin,
	editor: Editor,
	language_to: string,
	options: ServiceOptions,
	handle_text = "replace",
): Promise<TranslationResult> {
	if (editor.getSelection().length === 0) {
		plugin.message_queue("Selection is empty");
		return { status_code: 400, message: "Selection is empty" };
	}
	if (!plugin.translator)
		return { status_code: 400, message: "No translation service available" };

	const text = editor.getSelection();
	const result = await plugin.translator.translate(text, "auto", language_to, options);
	if (result.translation) {
		if (handle_text === "replace")
			editor.replaceSelection(result.translation);
		else if (handle_text === "below")
			editor.replaceSelection(text + "\n" + result.translation);
		else if (handle_text === "clipboard")
			await navigator.clipboard.writeText(result.translation);
	}

	if (result.message)
		plugin.message_queue(result.message);

	return result;
}

/**
 * Helper function for detecting the language of a selection, displays a notice with the output
 * @param plugin - The plugin instance (to get message_queue, global translator, etc.)
 * @param editor - Note editor instance
 */
export async function detect_selection(plugin: TranslatorPlugin, editor: Editor): Promise<void> {
	const selection = editor.getSelection();
	if (editor.getSelection().length === 0) {
		plugin.message_queue("Selection is empty");
		return;
	}

	let results;
	if (plugin.detector && plugin.detector.valid && plugin.detector.default)
		results = await plugin.detector.detect(selection);
	else if (plugin.translator)
		results = await plugin.translator!.detect(selection);
	else {
		plugin.message_queue("No translation service available");
		return;
	}

	if (results.message)
		new Notice(results.message, 4000);

	if (results.status_code === 200) {
		const detected_languages = results.detected_languages!.sort((a, b) => {
			return b.confidence! - a.confidence!;
		});

		if (detected_languages) {
			const alternatives = detected_languages.map((result) => {
				return `${t(result.language!)}` +
					(result.confidence !== undefined ? ` [${(result.confidence * 100).toFixed(2)}%]` : "");
			});

			new Notice(`Detected languages:\n\t${alternatives.join("\n\t")}`, 0);
		}
	}
}
