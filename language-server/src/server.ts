'use strict';

import {
	IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments, TextDocument,
	Diagnostic, DiagnosticSeverity, InitializeResult, TextDocumentPositionParams, CompletionItem,
	CompletionItemKind, SignatureHelp, Hover, DocumentSymbolParams, SymbolInformation,
	WorkspaceSymbolParams, Definition, ExecuteCommandParams, VersionedTextDocumentIdentifier, Location,
	TextDocumentSyncKind
} from 'vscode-languageserver';

import { Socket } from 'net';

import * as scriptfiles from './as_file';
import * as completion from './completion';
import * as typedb from './database';
import * as fs from 'fs';
let glob = require('glob');

import { Message, MessageType, readMessages, buildGoTo, buildDisconnect } from './unreal-buffers';

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a connection to unreal
let unreal : Socket;

function connect_unreal() {
	if (unreal != null)
	{
		unreal.write(buildDisconnect());
		unreal.destroy();
	}
	unreal = new Socket;
	//connection.console.log('Connecting to unreal editor...');

	unreal.on("data", function(data : Buffer) {
		let messages : Array<Message> = readMessages(data);
		for (let msg of messages)
		{
			if (msg.type == MessageType.Diagnostics)
			{
				if (!InitialPostProcessDone)
					RunInitialPostProcess();

				let diagnostics: Diagnostic[] = [];

				// Based on https://en.wikipedia.org/wiki/File_URI_scheme,
				// file:/// should be on both platforms, but on Linux the path
				// begins with / while on Windows it is omitted. So we need to
				// add it here to make sure both platforms are valid.
				let localpath = msg.readString();
				let filename = (localpath[0] == '/') ? ("file://" + localpath) : ("file:///" + localpath);
				//connection.console.log('Diagnostics received: '+filename);

				let msgCount = msg.readInt();
				for (let i = 0; i < msgCount; ++i)
				{
					let message = msg.readString();
					let line = msg.readInt();
					let char = msg.readInt();
					let isError = msg.readBool();
					let isInfo = msg.readBool();

					if (isInfo)
					{
						let hasExisting : boolean = false;
						for(let diag of diagnostics)
						{
							if (diag.range.start.line == line-1)
								hasExisting = true;
						}

						if(!hasExisting)
							continue;
					}

					let diagnosic: Diagnostic = {
						severity: isInfo ? DiagnosticSeverity.Information : (isError ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning),
						range: {
							start: { line: line-1, character: 0 },
							end: { line: line-1, character: 10000 }
						},
						message: message,
						source: 'as'
					};
					diagnostics.push(diagnosic);
				}

				connection.sendDiagnostics({ uri: filename, diagnostics });
			}
			else if(msg.type == MessageType.DebugDatabase)
			{
				let dbStr = msg.readString();
				let dbObj = JSON.parse(dbStr);
				typedb.AddTypesFromUnreal(dbObj);
			}
		}
	});

	unreal.on("error", function() {
		if (unreal != null)
		{
			unreal.destroy();
			unreal = null;
			setTimeout(connect_unreal, 5000);
		}
	});

	unreal.on("close", function() {
		if (unreal != null)
		{
			unreal.destroy();
			unreal = null;
			setTimeout(connect_unreal, 5000);
		}
	});

	unreal.connect(27099, "localhost", function()
	{
		//connection.console.log('Connection to unreal editor established.');
		setTimeout(function()
		{
			if (!unreal)
				return;
			let reqDb = Buffer.alloc(5);
			reqDb.writeUInt32LE(1, 0);
			reqDb.writeUInt8(MessageType.RequestDebugDatabase, 4);

			unreal.write(reqDb);
		}, 1000);
	});
}

connect_unreal();

// Create a simple text document manager. The text document manager
// supports full document sync only
// Make the text document manager listen on the connection
// for open, change and close text document events

let shouldSendDiagnosticRelatedInformation: boolean = false;
let RootPath : string = "";
let RootUri : string = "";

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
connection.onInitialize((_params): InitializeResult => {
	RootPath = _params.rootPath;
	RootUri = decodeURIComponent(_params.rootUri);
	shouldSendDiagnosticRelatedInformation = _params.capabilities && _params.capabilities.textDocument && _params.capabilities.textDocument.publishDiagnostics && _params.capabilities.textDocument.publishDiagnostics.relatedInformation;

	//connection.console.log("RootPath: "+RootPath);
	//connection.console.log("RootUri: "+RootUri+" from "+_params.rootUri);

	typedb.AddPrimitiveTypes();

	// Read all files in the workspace before we complete initialization, so we have completion on everything
	glob(RootPath+"/**/*.as", null, function(err : any, files : any)
	{
		let modules : Array<scriptfiles.ASFile> = [];
		for (let file of files)
		{
			let uri = getFileUri(file);
			let asfile = UpdateFileFromDisk(uri);
			if (asfile)
				modules.push(asfile);
		}
	});

	return {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: TextDocumentSyncKind.Full,
			// Tell the client that the server support code complete
			completionProvider: {
				resolveProvider: true,
				triggerCharacters: [".", ":"],
			},
			signatureHelpProvider: {
				triggerCharacters: ["(", ")", ","],
			},
			hoverProvider: true,
			documentSymbolProvider: true,
			workspaceSymbolProvider: true,
			definitionProvider: true,
			implementationProvider: true
		}
	}
});

let InitialPostProcessDone = false;
function RunInitialPostProcess()
{
	for (let file of scriptfiles.GetAllFiles())
	{
		completion.ResolveAutos(file.rootscope);
		scriptfiles.PostProcessModule(file.modulename);
	}
	InitialPostProcessDone = true;
}

connection.onDidChangeWatchedFiles((_change) => {
	for(let change of _change.changes)
	{
		let file = UpdateFileFromDisk(change.uri);
		if (file)
		{
			completion.ResolveAutos(file.rootscope);
			scriptfiles.PostProcessModule(file.modulename);
		}
	}
});

// This handler provides the initial list of the completion items.
connection.onCompletion((_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
	let completions = completion.Complete(_textDocumentPosition);
	let debug = modules;
	//connection.console.log(JSON.stringify(completions));
	return completions;
});


// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	return completion.Resolve(item);
});

connection.onSignatureHelp((_textDocumentPosition: TextDocumentPositionParams): SignatureHelp => {
	return completion.Signature(_textDocumentPosition);
});

connection.onDefinition((_textDocumentPosition: TextDocumentPositionParams): Definition | null => {
	let compl = completion.GetCompletionTypeAndMember(_textDocumentPosition);
	if (!compl)
		return null;

	let [typename, symbolname] = compl;
	
	let definition = completion.GetDefinition(_textDocumentPosition);
	if (definition)
		return definition;

	return null;
});

connection.onImplementation((_textDocumentPosition: TextDocumentPositionParams): Definition | null => {
	let compl = completion.GetCompletionTypeAndMember(_textDocumentPosition);
	if (!compl)
		return null;

	let [typename, symbolname] = compl;
	//connection.console.log("Looking up Symbol (Implementation): ["+typename+", "+symbolname+"]");

	let definition = completion.GetDefinition(_textDocumentPosition);
	if (definition)
		return definition;
		
	// We didn't find a definition in angelscript, let's see what happens if we poke
	// the unreal editor with the type and symbol we've resolved that we want.
	if(unreal)
		unreal.write(buildGoTo(completion.GetUnrealTypeFor(typename), symbolname));

	return null;
});

connection.onHover((_textDocumentPosition: TextDocumentPositionParams): Hover => {
	return completion.GetHover(_textDocumentPosition);
});

connection.onDocumentSymbol((_params : DocumentSymbolParams) : SymbolInformation[] => {
	return completion.DocumentSymbols(_params.textDocument.uri);
});

connection.onWorkspaceSymbol((_params : WorkspaceSymbolParams) : SymbolInformation[] => {
	return completion.WorkspaceSymbols(_params.query);
});

function UpdateFileFromDisk(uri : string) : scriptfiles.ASFile
{
	let filename = getPathName(uri);
	let modulename = getModuleName(uri);

	if (!fs.existsSync(filename)) {
		return scriptfiles.UpdateContent(uri, modulename, "");
	}

	let stat = fs.lstatSync(filename);
	if (!stat.isFile())
		return null;
	
	//connection.console.log("Update from disk 2: "+uri+" = "+modulename+" @ "+filename);

	let content = fs.readFileSync(filename, 'utf8');
	return scriptfiles.UpdateContent(uri, modulename, content, null);
}

function getPathName(uri : string) : string
{
	let pathname = decodeURIComponent(uri.replace("file://", ""));
	if(pathname.startsWith("\\"))
		pathname = pathname.substr(1);

	return pathname;
}

function getFileUri(pathname : string) : string
{
	let uri = pathname.replace(/\\/g, "/");
	if(!uri.startsWith("/"))
		uri = "/" + uri;

	return ("file://" + uri);
}

function getModuleName(uri : string) : string
{
	let modulename = decodeURIComponent(uri);
	modulename = modulename.replace(RootUri, "");
	modulename = modulename.replace(".as", "");
	modulename = modulename.replace(/\//g, ".");

	if (modulename[0] == '.')
		modulename = modulename.substr(1);

	return modulename;
}

/*documents.onDidChangeContent((change) => {
	let content = change.document.getText();
	let uri = change.document.uri;
	let modulename = getModuleName(uri);

	//connection.console.log("Update from CODE: "+uri);
	
	let file = scriptfiles.UpdateContent(uri, modulename, content, change.document);
	completion.ResolveAutos(file.rootscope);
	scriptfiles.PostProcessModule(modulename);
});*/

connection.onRequest("angelscript/getModuleForSymbol", (...params: any[]) : string => {
	let pos : TextDocumentPositionParams = params[0];

	let def = completion.GetDefinition(pos);
	if (def == null)
	{
		connection.console.log(`Definition not found`);
		return "";
	}

	let defArr = def as Location[];

	let uri = defArr[0].uri;
	let module = getModuleName(uri);

	//connection.console.log(`Definition found at ${module}`);

	return module;
});
	
 connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.

	if (params.contentChanges.length == 0)
		return;

	let content = params.contentChanges[0].text;
	let uri = params.textDocument.uri;
	let modulename = getModuleName(uri);
	
	let file = scriptfiles.UpdateContent(uri, modulename, content, null);
	completion.ResolveAutos(file.rootscope);
	scriptfiles.PostProcessModule(modulename);
 });

// Listen on the connection
connection.listen();
