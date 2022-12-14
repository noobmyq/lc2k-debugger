/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * mockDebug.ts implements the Debug Adapter that "adapts" or translates the Debug Adapter Protocol (DAP) used by the client (e.g. VS Code)
 * into requests and events of the real "execution engine" or "debugger" (here: class MockRuntime).
 * When implementing your own debugger extension for VS Code, most of the work will go into the Debug Adapter.
 * Since the Debug Adapter is independent from VS Code, it can be used in any client (IDE) supporting the Debug Adapter Protocol.
 *
 * The most important class of the Debug Adapter is the MockDebugSession which implements many DAP requests by talking to the MockRuntime.
 */

import {
    Logger, logger,
    LoggingDebugSession,
    InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
    InvalidatedEvent,
    Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { basename } from 'path-browserify';
import { MockRuntime, IRuntimeBreakpoint, FileAccessor, RuntimeVariable, IRuntimeVariableType, RuntimeException } from './mockRuntime';
import { Subject } from 'await-notify';

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** An absolute path to the "program" to debug. */
    program: string;
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean;
    /** enable logging the Debug Adapter Protocol */
    trace?: boolean;
    /** run without debugging */
    noDebug?: boolean;
    /** if specified, results in a simulated compile error in launch. */
    compileError?: 'default' | 'show' | 'hide';
}

interface IAttachRequestArguments extends ILaunchRequestArguments { }


export class MockDebugSession extends LoggingDebugSession {

    // we don't support multiple threads, so we can use a hardcoded ID for the default thread
    private static threadID = 1;

    // a Mock runtime (or debugger)
    private _runtime: MockRuntime;

    private _variableHandles = new Handles<'regs' | 'mems' | RuntimeVariable>();

    private _configurationDone = new Subject();

    private _cancellationTokens = new Map<number, boolean>();
    private _exceptionMsg: string | undefined;
    private _exceptionType: RuntimeException = RuntimeException.None;
    private _valuesInHex = false;
    private _useInvalidatedEvent = false;

    private _addressesInHex = true;

    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    public constructor(fileAccessor: FileAccessor) {
        super("mock-debug.txt");

        // this debugger uses zero-based lines and columns
        this.setDebuggerLinesStartAt1(false);
        this.setDebuggerColumnsStartAt1(false);

        this._runtime = new MockRuntime(fileAccessor);

        // setup event handlers
        this._runtime.on('stopOnEntry', () => {
            this.sendEvent(new StoppedEvent('entry', MockDebugSession.threadID));
        });
        this._runtime.on('stopOnStep', () => {
            this.sendEvent(new StoppedEvent('step', MockDebugSession.threadID));
        });
        this._runtime.on('stopOnBreakpoint', () => {
            this.sendEvent(new StoppedEvent('breakpoint', MockDebugSession.threadID));
        });
        this._runtime.on('stopOnDataBreakpoint', () => {
            this.sendEvent(new StoppedEvent('data breakpoint', MockDebugSession.threadID));
        });
        this._runtime.on('stopOnInstructionBreakpoint', () => {
            this.sendEvent(new StoppedEvent('instruction breakpoint', MockDebugSession.threadID));
        });
        this._runtime.on('stopOnException', (exception) => {
            if (exception) {
                const error_num_REGEX = /^[0-9]\s/g;
                var match = error_num_REGEX.exec(exception)
                if (match) {
                    this._exceptionType = Number(match[0]) as RuntimeException;
                }
                const line_REGEX = /^[0-9] in line: (.*)/g
                match = line_REGEX.exec(exception)
                if (match) {
                    this._exceptionMsg = match[1];
                }
            }
            this.sendEvent(new StoppedEvent('exception', MockDebugSession.threadID));
        });
        this._runtime.on('breakpointValidated', (bp: IRuntimeBreakpoint) => {
            this.sendEvent(new BreakpointEvent('changed', { verified: bp.verified, id: bp.id } as DebugProtocol.Breakpoint));
        });
        this._runtime.on('output', (type, text, filePath, line, column) => {

            let category: string;
            switch (type) {
                case 'prio': category = 'important'; break;
                case 'out': category = 'stdout'; break;
                case 'err': category = 'stderr'; break;
                default: category = 'console'; break;
            }
            const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`, category);

            if (text === 'start' || text === 'startCollapsed' || text === 'end') {
                e.body.group = text;
                e.body.output = `group-${text}\n`;
            }

            e.body.source = this.createSource(filePath);
            e.body.line = this.convertDebuggerLineToClient(line);
            e.body.column = this.convertDebuggerColumnToClient(column);
            this.sendEvent(e);
        });
        this._runtime.on('end', () => {
            this.sendEvent(new TerminatedEvent());
        });
    }

    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

        if (args.supportsProgressReporting) {
            // this._reportProgress = true;
        }
        if (args.supportsInvalidatedEvent) {
            this._useInvalidatedEvent = true;
        }

        // build and return the capabilities of this debug adapter:
        response.body = response.body || {};

        // the adapter implements the configurationDone request.
        response.body.supportsConfigurationDoneRequest = true;

        // make VS Code use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = true;

        // make VS Code show a 'step back' button
        response.body.supportsStepBack = false;
        // make VS Code support data breakpoints
        response.body.supportsDataBreakpoints = true;


        // make VS Code send cancel request
        response.body.supportsCancelRequest = true;

        // make VS Code send the breakpointLocations request
        response.body.supportsBreakpointLocationsRequest = true;

        // make VS Code provide "Step in Target" functionality
        response.body.supportsStepInTargetsRequest = false;



        // make VS Code send exceptionInfo request
        response.body.supportsExceptionInfoRequest = true;

        // make VS Code send setVariable request
        response.body.supportsSetVariable = true;

        // make VS Code send setExpression request
        response.body.supportsSetExpression = true;

        // make VS Code send disassemble request
        response.body.supportsDisassembleRequest = false;
        response.body.supportsSteppingGranularity = true;
        response.body.supportsInstructionBreakpoints = true;

        // make VS Code able to read and write variable memory
        response.body.supportsReadMemoryRequest = true;
        response.body.supportsWriteMemoryRequest = true;

        response.body.supportSuspendDebuggee = true;
        response.body.supportTerminateDebuggee = true;
        response.body.supportsFunctionBreakpoints = true;

        this.sendResponse(response);

        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());
    }

    /**
     * Called at the end of the configuration sequence.
     * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
     */
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        super.configurationDoneRequest(response, args);

        // notify the launchRequest that configuration has finished
        this._configurationDone.notify();
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
        console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {
        return this.launchRequest(response, args);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

        // make sure to 'Stop' the buffered logging if 'trace' is not set
        logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

        // wait 1 second until configuration has finished (and configurationDoneRequest has been called)
        await this._configurationDone.wait(1000);

        // start the program in the runtime
        await this._runtime.start(args.program, !!args.stopOnEntry, !args.noDebug);

        if (args.compileError) {
            // simulate a compile/build error in "launch" request:
            // the error should not result in a modal dialog since 'showUser' is set to false.
            // A missing 'showUser' should result in a modal dialog.
            this.sendErrorResponse(response, {
                id: 1001,
                format: `compile error: some fake error.`,
                showUser: args.compileError === 'show' ? true : (args.compileError === 'hide' ? false : undefined)
            });
        } else {
            this.sendResponse(response);
        }
    }

    protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {

        const path = args.source.path as string;
        const clientLines = args.lines || [];

        // clear all breakpoints for this file
        this._runtime.clearBreakpoints(path);

        // set and verify breakpoint locations
        const actualBreakpoints0 = clientLines.map(async l => {
            const { verified, line, id } = await this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(l));
            const bp = new Breakpoint(verified, this.convertDebuggerLineToClient(line)) as DebugProtocol.Breakpoint;
            bp.id = id;
            return bp;
        });
        const actualBreakpoints = await Promise.all<DebugProtocol.Breakpoint>(actualBreakpoints0);

        // send back the actual breakpoint positions
        response.body = {
            breakpoints: actualBreakpoints
        };
        this.sendResponse(response);
    }

    protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {

        if (args.source.path) {
            const bps = this._runtime.getBreakpoints(args.source.path, this.convertClientLineToDebugger(args.line));
            response.body = {
                breakpoints: bps.map(col => {
                    return {
                        line: args.line,
                        column: this.convertDebuggerColumnToClient(col)
                    };
                })
            };
        } else {
            response.body = {
                breakpoints: []
            };
        }
        this.sendResponse(response);
    }
    protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments) {
        var description_msg: string = "Exception description";
        var detailed_explain: string | undefined = undefined;
        switch (this._exceptionType as RuntimeException) {
            case RuntimeException.InvalidInstruction:
                description_msg = "Invalid instruction";
                detailed_explain = "There are only 8 valid instruction, are you using one of them?";
                break;
            case RuntimeException.InvalidMemory:
                description_msg = "Invalid memory access";
                detailed_explain = "You are trying to access memory that is not accessable by LC2K";
                break;
            case RuntimeException.InvalidRegister:
                description_msg = "Invalid register access"
                detailed_explain = "Please notice that there are only 8 registers so you can only access R0-R7";
                break;
            case RuntimeException.InvalidLabel:
                description_msg = "Invalid label"
                detailed_explain = "Have you defined it before?";
                break;
            default:
                break;
        }

        response.body = {
            exceptionId: String(args.threadId),
            description: description_msg + ` in line\n ${this._exceptionMsg}\n${detailed_explain}`,
            breakMode: 'always',
            details: {
                message: 'Message contained in the exception.',
                typeName: 'Short type name of the exception object',
                // set the font size

            }
        };
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

        // runtime supports no threads so just return a default thread.
        response.body = {
            threads: [
                new Thread(MockDebugSession.threadID, "thread 1")
            ]
        };
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

        const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
        const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
        const endFrame = startFrame + maxLevels;

        const stk = this._runtime.stack(startFrame, endFrame);

        response.body = {
            stackFrames: stk.frames.map((f, ix) => {
                const sf: DebugProtocol.StackFrame = new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line));
                if (typeof f.column === 'number') {
                    sf.column = this.convertDebuggerColumnToClient(f.column);
                }
                if (typeof f.instruction === 'number') {
                    const address = this.formatAddress(f.instruction);
                    sf.name = `${f.name} ${address}`;
                    sf.instructionPointerReference = address;
                }

                return sf;
            }),
            // 4 options for 'totalFrames':
            //omit totalFrames property: 	// VS Code has to probe/guess. Should result in a max. of two requests
            totalFrames: stk.count			// stk.count is the correct size, should result in a max. of two requests
            //totalFrames: 1000000 			// not the correct size, should result in a max. of two requests
            //totalFrames: endFrame + 20 	// dynamically increases the size with every requested chunk, results in paging
        };
        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

        response.body = {
            scopes: [
                new Scope("Registers", this._variableHandles.create('regs'), false),
                new Scope("Mems", this._variableHandles.create('mems'), false)
            ]
        };
        this.sendResponse(response);
    }



    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {

        let vs: RuntimeVariable[] = [];

        const v = this._variableHandles.get(args.variablesReference);
        if (v === 'regs') {
            vs = this._runtime.getRegisters();
        } else if (v === 'mems') {
            vs = this._runtime.getMemory();
        }

        response.body = {
            variables: vs.map(v => this.convertFromRuntime(v))
        };
        this.sendResponse(response);
    }

    protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
        const container = this._variableHandles.get(args.variablesReference);

        const rv = container === 'regs' ? this._runtime.getLocalVariable(args.name) : undefined;
        if (rv) {
            rv.value = this.convertToRuntime(args.value);
            response.body = this.convertFromRuntime(rv);

        }

        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this._runtime.continue();
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        this._runtime.step();
        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        this._runtime.step();
        this.sendResponse(response);
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        // no step out, do nothing
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        var value: DebugProtocol.Variable | undefined = undefined;

        const REG_EXP_PARSER = /^reg [0-9]/g;
        const MEM_EXP_PARSER = /^mem [0-9]/g;
        var match: RegExpExecArray | null;
        if (match = REG_EXP_PARSER.exec(args.expression)) {
            const reg = this._runtime.getLocalVariable(match[0])!;
            value = (this.convertFromRuntime(reg));
        } else if (match = MEM_EXP_PARSER.exec(args.expression)) {
            const NUMBER_PARSER = /\s[0-9]*/g;
            const loc = Number(NUMBER_PARSER.exec(args.expression)!);
            const mem: number = this._runtime.getLocalVariable('mem')?.value[loc];
            const memVar: RuntimeVariable = new RuntimeVariable('mem', mem);
            value = (this.convertFromRuntime(memVar));
        }
        const v: DebugProtocol.Variable = value ? value : {
            name: 'eval',
            value: 'lol, not available',
            type: 'string',
            variablesReference: 0,
            evaluateName: '$'
        };
        response.body = {
            result: v.value,
            type: v.type,
            variablesReference: v.variablesReference,
            presentationHint: v.presentationHint
        };

        this.sendResponse(response);
    }

    protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): void {

        if (args.expression.startsWith('$')) {
            const rv = this._runtime.getLocalVariable(args.expression.substr(1));
            if (rv) {
                rv.value = this.convertToRuntime(args.value);
                response.body = this.convertFromRuntime(rv);
                this.sendResponse(response);
            } else {
                this.sendErrorResponse(response, {
                    id: 1002,
                    format: `variable '{lexpr}' not found`,
                    variables: { lexpr: args.expression },
                    showUser: true
                });
            }
        } else {
            this.sendErrorResponse(response, {
                id: 1003,
                format: `'{lexpr}' not an assignable expression`,
                variables: { lexpr: args.expression },
                showUser: true
            });
        }
    }


    protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {

        response.body = {
            dataId: null,
            description: "cannot break on data access",
            accessTypes: undefined,
            canPersist: false
        };

        if (args.variablesReference && args.name) {
            const v = this._variableHandles.get(args.variablesReference);
            if (v === 'mems') {
                response.body.dataId = args.name;
                response.body.description = args.name;
                response.body.accessTypes = ["write"];
                response.body.canPersist = true;
            } else {
                response.body.dataId = args.name;
                response.body.description = args.name;
                response.body.accessTypes = ["read", "write", "readWrite"];
                response.body.canPersist = true;
            }
        }

        this.sendResponse(response);
    }

    protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {

        // clear all data breakpoints
        this._runtime.clearAllDataBreakpoints();

        response.body = {
            breakpoints: []
        };

        for (const dbp of args.breakpoints) {
            const ok = this._runtime.setDataBreakpoint(dbp.dataId, dbp.accessType || 'write');
            response.body.breakpoints.push({
                verified: ok
            });
        }

        this.sendResponse(response);
    }


    protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
        if (args.requestId) {
            this._cancellationTokens.set(args.requestId, true);
        }
        if (args.progressId) {
            // this._cancelledProgressId = args.progressId;
        }
    }



    protected setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments) {

        // clear all instruction breakpoints
        this._runtime.clearInstructionBreakpoints();

        // set instruction breakpoints
        const breakpoints = args.breakpoints.map(ibp => {
            const address = parseInt(ibp.instructionReference);
            const offset = ibp.offset || 0;
            return <DebugProtocol.Breakpoint>{
                verified: this._runtime.setInstructionBreakpoint(address + offset)
            };
        });

        response.body = {
            breakpoints: breakpoints
        };
        this.sendResponse(response);
    }

    protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
        if (command === 'toggleFormatting') {
            this._valuesInHex = !this._valuesInHex;
            if (this._useInvalidatedEvent) {
                this.sendEvent(new InvalidatedEvent(['variables']));
            }
            this.sendResponse(response);
        } else {
            super.customRequest(command, response, args);
        }
    }

    //---- helpers

    private convertToRuntime(value: string): IRuntimeVariableType {

        value = value.trim();

        if (value === 'true') {
            return true;
        }
        if (value === 'false') {
            return false;
        }
        // TODO:
        // if value is of form 'reg 0' then return a register variable
        const reg_regex = value.match(/^reg (\d+)$/);
        if (reg_regex) { }
        const n = parseFloat(value);
        if (!isNaN(n)) {
            return n;
        }
        return value;
    }

    private convertFromRuntime(v: RuntimeVariable): DebugProtocol.Variable {

        let dapVariable: DebugProtocol.Variable = {
            name: v.name,
            value: '???',
            type: typeof v.value,
            variablesReference: 0,
            evaluateName: '$' + v.name
        };

        if (v.name.indexOf('lazy') >= 0) {
            // a "lazy" variable needs an additional click to retrieve its value

            dapVariable.value = 'lazy var';		// placeholder value
            v.reference ??= this._variableHandles.create(new RuntimeVariable('', [new RuntimeVariable('', v.value)]));
            dapVariable.variablesReference = v.reference;
            dapVariable.presentationHint = { lazy: true };
        } else {

            if (Array.isArray(v.value)) {
                dapVariable.value = 'Object';
                v.reference ??= this._variableHandles.create(v);
                dapVariable.variablesReference = v.reference;
            } else {

                switch (typeof v.value) {
                    case 'number':
                        if (Math.round(v.value) === v.value) {
                            dapVariable.value = this.formatNumber(v.value);
                            (<any>dapVariable).__vscodeVariableMenuContext = 'simple';	// enable context menu contribution
                            dapVariable.type = 'integer';
                        } else {
                            dapVariable.value = v.value.toString();
                            dapVariable.type = 'float';
                        }
                        break;
                    case 'string':
                        dapVariable.value = `"${v.value}"`;
                        break;
                    case 'boolean':
                        dapVariable.value = v.value ? 'true' : 'false';
                        break;
                    default:
                        dapVariable.value = typeof v.value;
                        break;
                }
            }
        }



        return dapVariable;
    }

    private formatAddress(x: number, pad = 8) {
        return this._addressesInHex ? '0x' + x.toString(16).padStart(8, '0') : x.toString(10);
    }

    private formatNumber(x: number) {
        return this._valuesInHex ? '0x' + x.toString(16) : x.toString(10);
    }

    private createSource(filePath: string): Source {
        return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
    }
}

