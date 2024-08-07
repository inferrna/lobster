import { URI } from "vscode-uri";
import { LSPInstance } from "../lsp";
import { LobsterDocumentState } from "../document";
import { getWordOnCursor, markupSignature } from "../utils";
import { LobsterSignature, queryDefinition } from "../lobster";
import { uinteger } from "vscode-languageserver";

export default function setupFeature(lsp: LSPInstance) {
    lsp.connection.onHover(async (params) => {
        console.error("onHover");
        if (lsp.errored()) return null;

        const uri = URI.parse(params.textDocument.uri);
        const document = lsp.documents.get(uri.toString())!;

        console.error("onHover document = "+document);
        const lineText = document.getText({
            start: { line: params.position.line, character: 0 },
            end: { line: params.position.line, character: uinteger.MAX_VALUE },
        });
        const [word, inFront] = getWordOnCursor(
            lineText,
            params.position.character,
        );
        console.error("onHover got word "+word);
        if (!word) return null;

        let signature: LobsterSignature | undefined;

        if (document.state === LobsterDocumentState.HasErrors) {
            console.error("onHover go to HasErrors branch");
            signature = lsp.getFunctionSignature(word);
        } else {
            console.error("onHover go to settings ");
            const settings = await lsp.getDocumentSettings(uri);
            console.error("onHover got settings "+JSON.stringify(settings));

            const temp = await document.writeToTmp(lsp);
            console.error("onHover wrotte document ");
            const result = await queryDefinition(
                settings,
                temp,
                params.position.line,
                word,
            );

            signature = result.signature;
        }

        if (signature) {
            return {
                contents: markupSignature(signature),
                range: {
                    start: {
                        line: params.position.line,
                        character: params.position.character - inFront,
                    },
                    end: {
                        line: params.position.line,
                        character: params.position.character + word.length - inFront,
                    },
                },
            };
        }

        return null;
    });
}
