import { Connection, TextDocuments, WorkspaceFolder } from "vscode-languageserver";
import { exec } from 'child_process';
import { URI } from "vscode-uri";
import { LobsterDocument, LobsterDocumentState } from "./document";
import { LobsterBuiltinsDoc, LobsterFunctionSignature, getBuiltinsDoc } from "./lobster";

export interface LobsterSettings {
    executable: string,
    imports: string[],
    experimental: boolean
}

export enum ErroredState {
    None,
    InvalidExecutable,
}

const defaultSettings: LobsterSettings = { executable: 'lobster', imports: [], experimental: false };

export class LSPInstance {
    connection: Connection;
    tempDir: string;
    globalSettings: LobsterSettings = defaultSettings;
    errorState: ErroredState = ErroredState.None;
    builtinsDoc: LobsterBuiltinsDoc[] = [];

    readonly documents: TextDocuments<LobsterDocument> = new TextDocuments(LobsterDocument);
    // Cached per document settings
    readonly documentSettings: Map<URI, Thenable<LobsterSettings>> = new Map();

    hasConfigurationCapability = false;

    constructor(connection: Connection, tempDir: string) {
        this.tempDir = tempDir;
        this.connection = connection;

        this.documents.onDidClose(e => {
            this.documentSettings.delete(URI.parse(e.document.uri));
        });

        this.documents.onDidChangeContent(change => {
            this.validateDocument(change.document);
        });

        this.documents.listen(this.connection);
    }

    readConfiguration(uri: URI): Promise<LobsterSettings> {
        const config = this.connection.workspace.getConfiguration({
            scopeUri: uri.toString(),
            section: 'lobster'
        }) as Promise<LobsterSettings>;

        //Validate config
        config.then(_c => {
            const c = _c || defaultSettings;

            const throwError = (msg: string) => {
                this.connection.window.showErrorMessage(msg);
                this.errorState = ErroredState.InvalidExecutable;
                return config;
            };

            if (c.executable.length == 0)
                return throwError("Lobster executable path is not set.");

            getBuiltinsDoc(c).then((d) => this.builtinsDoc = d);

            exec(c.executable, (error, stdout, stderr) => {
                if (stderr) {
                    return throwError(`Lobster (${c.executable}) returned with output: ${stderr}`);
                } else if (error && error.code != 1) { // If errorcode 1 then its the help message
                    return throwError(`Lobster (${c.executable}) failed to execute: ${error.message}`);
                } else if (!stdout.startsWith("Lobster programming language")) {
                    return throwError(`Lobster (${c.executable}) returned with unexpected output (is this a lobster binary?): ${stdout}`);
                }
            });
        });

        this.documentSettings.set(uri, config);
        return config;
    }

    async getDocumentSettings(uri: URI): Promise<LobsterSettings> {
        if (!this.hasConfigurationCapability) {
            return Promise.resolve(this.globalSettings);
        }

        let result = this.documentSettings.get(uri);
        if (!result) {
            result = this.readConfiguration(uri);
        }

        const folders = [uri.fsPath];
        folders.concat(await this.getWorkspaceFoldersPaths());

        console.error("Got folders in getDocumentSettings: " + JSON.stringify(folders));
        console.error("Got result in getDocumentSettings: " + JSON.stringify(result));
        return result.then(s => (s ? {
            executable: s.executable || this.globalSettings.executable,
            imports: [...s.imports, ...folders],
            experimental: s.experimental || this.globalSettings.experimental
        } : defaultSettings));
    }

    async validateDocument(document: LobsterDocument) {
        const noErrBefore = document.state === LobsterDocumentState.NoErrors;
        const diagnostics = await document.parse(this);
        if (!noErrBefore || diagnostics.length > 0) {
            this.connection.sendDiagnostics({
                uri: document.uri,
                diagnostics
            });
        }
    }

    async getWorkspaceFolders(): Promise<WorkspaceFolder[] | null> {
        if (!this.connection) return null;
        if (this.errored()) return null;

        const folders = this.connection.workspace.getWorkspaceFolders();
        console.error("Got folders in getWorkspaceFolders: " + JSON.stringify(folders));
        return folders;
    }

    async getWorkspaceFoldersPaths(): Promise<string[]> {
        if (this.errored()) return [];

        const folders = await this.getWorkspaceFolders();
        console.error("Got folders in getWorkspaceFoldersPaths: " + JSON.stringify(folders));
        if (!folders) return [];
        return folders.map(f => URI.parse(f.uri).fsPath);
    }

    getFunctionSignature(funcname: string): LobsterFunctionSignature | undefined {
        const doc: LobsterBuiltinsDoc | undefined = this.builtinsDoc
            .find((d) => d.funcname == funcname);
        if (!doc) return undefined;
        const res: LobsterFunctionSignature = {
            name: doc.funcname,
            parameters: doc.args,
            returns: doc.returns
        };
        return res;
    }

    errored(): boolean {
        return this.errorState != ErroredState.None;
    }
}
