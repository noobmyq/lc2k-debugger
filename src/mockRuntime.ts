/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';

export interface FileAccessor {
    isWindows: boolean;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, contents: Uint8Array): Promise<void>;
}

export interface IRuntimeBreakpoint {
    id: number;
    line: number;
    verified: boolean;
}


interface IRuntimeStackFrame {
    index: number;
    name: string;
    file: string;
    line: number;
    column?: number;
    instruction?: number;
}

interface IRuntimeStack {
    count: number;
    frames: IRuntimeStackFrame[];
}


export type IRuntimeVariableType = number | boolean | string | RuntimeVariable[];

export class RuntimeVariable {
    // private _memory?: Uint8Array;

    public reference?: number;

    public get value() {
        return this._value;
    }

    public set value(value: IRuntimeVariableType) {
        this._value = value;
    }


    constructor(public readonly name: string, private _value: IRuntimeVariableType) { }

}

interface Word {
    name: string;
    line: number;
    index: number;
}

export function timeout(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * A Mock runtime with minimal debugger functionality.
 * MockRuntime is a hypothetical (aka "Mock") "execution engine with debugging support":
 * it takes a Markdown (*.md) file and "executes" it by "running" through the text lines
 * and searching for "command" patterns that trigger some debugger related functionality (e.g. exceptions).
 * When it finds a command it typically emits an event.
 * The runtime can not only run through the whole file but also executes one line at a time
 * and stops on lines for which a breakpoint has been registered. This functionality is the
 * core of the "debugging support".
 * Since the MockRuntime is completely independent from VS Code or the Debug Adapter Protocol,
 * it can be viewed as a simplified representation of a real "execution engine" (e.g. node.js)
 * or debugger (e.g. gdb).
 * When implementing your own debugger extension for VS Code, you probably don't need this
 * class because you can rely on some existing debugger or runtime.
 */
export class MockRuntime extends EventEmitter {

    // the initial (and one and only) file we are 'debugging'
    private _sourceFile: string = '';
    public get sourceFile() {
        return this._sourceFile;
    }

    private variables = new Map<string, RuntimeVariable>();
    // array stores label maps line
    private labels: Word[] = [];

    // the contents (= lines) of the one and only file
    private sourceLines: string[] = [];
    // This is the next line that will be 'executed'
    private _currentLine = 0;
    private get currentLine() {
        return this._currentLine;
    }
    private set currentLine(x) {
        this._currentLine = x;
    }
    private currentColumn: number | undefined;

    // This is the next instruction that will be 'executed'

    // maps from sourceFile to array of IRuntimeBreakpoint
    private breakPoints = new Map<string, IRuntimeBreakpoint[]>();

    // all instruction breakpoint addresses
    private instructionBreakpoints = new Set<number>();

    // since we want to send breakpoint events, we will assign an id to every event
    // so that the frontend can match events with breakpoints.
    private breakpointId = 1;

    private breakAddresses = new Map<string, string>();


    constructor(private fileAccessor: FileAccessor) {
        super();
        // create local arrays of size 8: regs
        for (let i = 0; i < 8; i++) {
            this.variables.set(`reg ${i}`, new RuntimeVariable(`reg ${i}`, 0));
        }
        // create local vectors: mem
        this.variables.set('mem', new RuntimeVariable('mem', new Array(1000).fill(0)));
    }

    /**
     * Start executing the given program.
     */
    public async start(program: string, stopOnEntry: boolean, debug: boolean): Promise<void> {

        await this.loadSource(this.normalizePathAndCasing(program));

        if (debug) {
            await this.verifyBreakpoints(this._sourceFile);

            if (stopOnEntry) {
                this.findNextStatement('stopOnEntry');
            } else {
                // we just start to run until we hit a breakpoint, an exception, or the end of the program
                this.continue();
            }
        } else {
            this.continue();
        }
    }

    /**
     * Continue execution to the end/beginning.
     */
    public continue() {

        while (!this.executeLine(this.currentLine)) {
            if (this.updateCurrentLine()) {
                break;
            }
            if (this.findNextStatement()) {
                break;
            }
        }
    }

    /**
     * Step to the next/previous non empty line.
     */
    public step() {


        if (!this.executeLine(this.currentLine)) {
            if (!this.updateCurrentLine()) {
                this.findNextStatement('stopOnStep');
            }
        }

    }

    private updateCurrentLine(): boolean {

        if (this.currentLine < this.sourceLines.length - 1) {
            this.currentLine++;
        } else {
            // no more lines: run to end
            this.currentColumn = undefined;
            this.sendEvent('end');
            return true;
        }

        return false;
    }


    // TODO:
    // use jalr to record stack frame
    public stack(startFrame: number, endFrame: number): IRuntimeStack {

        const line = this.getLine();
        const words = this.getWords(this.currentLine, line);
        words.push({ name: 'BOTTOM', line: -1, index: -1 });	// add a sentinel so that the stack is never empty...

        // if the line contains the word 'disassembly' we support to "disassemble" the line by adding an 'instruction' property to the stackframe

        const column = typeof this.currentColumn === 'number' ? this.currentColumn : undefined;

        const frames: IRuntimeStackFrame[] = [];


        const stackFrame: IRuntimeStackFrame = {
            index: 0,
            name: line,	// use a word of the line as the stackframe name
            file: this._sourceFile,
            line: this.currentLine,
            column: column, // words[i].index
        };

        frames.push(stackFrame);


        return {
            frames: frames,
            count: words.length
        };
    }

    /*
     * Determine possible column breakpoint positions for the given line.
     * Here we return the start location of words with more than 8 characters.
     */
    public getBreakpoints(path: string, line: number): number[] {
        return this.getWords(line, this.getLine(line)).filter(w => w.name.length > 8).map(w => w.index);
    }

    /*
     * Set breakpoint in file with given line.
     */
    public async setBreakPoint(path: string, line: number): Promise<IRuntimeBreakpoint> {
        path = this.normalizePathAndCasing(path);

        const bp: IRuntimeBreakpoint = { verified: false, line, id: this.breakpointId++ };
        let bps = this.breakPoints.get(path);
        if (!bps) {
            bps = new Array<IRuntimeBreakpoint>();
            this.breakPoints.set(path, bps);
        }
        bps.push(bp);

        await this.verifyBreakpoints(path);

        return bp;
    }

    /*
     * Clear breakpoint in file with given line.
     */
    public clearBreakPoint(path: string, line: number): IRuntimeBreakpoint | undefined {
        const bps = this.breakPoints.get(this.normalizePathAndCasing(path));
        if (bps) {
            const index = bps.findIndex(bp => bp.line === line);
            if (index >= 0) {
                const bp = bps[index];
                bps.splice(index, 1);
                return bp;
            }
        }
        return undefined;
    }

    public clearBreakpoints(path: string): void {
        this.breakPoints.delete(this.normalizePathAndCasing(path));
    }

    public setDataBreakpoint(address: string, accessType: 'read' | 'write' | 'readWrite'): boolean {

        const x = accessType === 'readWrite' ? 'read write' : accessType;

        const t = this.breakAddresses.get(address);
        if (t) {
            if (t !== x) {
                this.breakAddresses.set(address, 'read write');
            }
        } else {
            this.breakAddresses.set(address, x);
        }
        return true;
    }

    public clearAllDataBreakpoints(): void {
        this.breakAddresses.clear();
    }

    public setInstructionBreakpoint(address: number): boolean {
        this.instructionBreakpoints.add(address);
        return true;
    }

    public clearInstructionBreakpoints(): void {
        this.instructionBreakpoints.clear();
    }

    public getRegisters(): RuntimeVariable[] {
        var regs: RuntimeVariable[] = [];
        for (let i = 0; i < 8; i++) {
            regs.push(this.variables.get(`reg ${i}`)!);
        }
        return regs;
    }
    public getMemory(): RuntimeVariable[] {
        var mems: RuntimeVariable[] = [];
        for (let i = 0; i < 300; i++) {
            const v = this.variables.get(`mem`)!.value[i];
            if (v) {
                mems.push(new RuntimeVariable(`mem[${i}]`, v));
            }
        }
        return mems;
    }



    public getLocalVariable(name: string): RuntimeVariable | undefined {
        return this.variables.get(name);
    }


    // private methods

    private getLine(line?: number): string {
        return this.sourceLines[line === undefined ? this.currentLine : line];
    }

    private getWords(l: number, line: string): Word[] {
        // break line into words
        const WORD_REGEXP = /[a-z]+/ig;
        const words: Word[] = [];
        let match: RegExpExecArray | null;
        while (match = WORD_REGEXP.exec(line)) {
            words.push({ name: match[0], line: l, index: match.index });
        }
        return words;
    }

    private async loadSource(file: string): Promise<void> {
        if (this._sourceFile !== file) {
            this._sourceFile = this.normalizePathAndCasing(file);
            this.initializeContents(await this.fileAccessor.readFile(file));
        }
    }

    private initializeContents(memory: Uint8Array) {
        this.sourceLines = new TextDecoder().decode(memory).split(/\r?\n/);

        // allocate memory for mem
        this.variables.set('mem', new RuntimeVariable('mem', new Array(this.sourceLines.length)));
        // extract all the labels
        for (let l = 0; l < this.sourceLines.length; l++) {
            const line = this.sourceLines[l];
            if (line[0] !== '\t') {
                // it is a label
                const SEP_REGEXP = /^([^\s]*)\s/g;
                const match = SEP_REGEXP.exec(line);
                if (match) {
                    this.labels.push({ name: match[1], line: l, index: 0 });
                }
                // check if it is .fill
                const FILL_REGEXP = /^([^\s]*)\s+(\.fill)\s+([^\s]+)(\s+)?(.*)?/g;
                const fillMatch = FILL_REGEXP.exec(line);
                if (fillMatch) {
                    const label = this.labels.find(l => l.name === fillMatch[1])?.line;
                    if (label === undefined) {
                        this.sendEvent('output', 'console', `Error: label ${fillMatch[1]} not found`, this._sourceFile, l);
                        this.sendEvent('stopOnException', undefined);
                        return;
                    }
                    let value = !isNaN(Number(fillMatch[3])) ? parseInt(fillMatch[3]) : fillMatch[3];
                    if (typeof value === 'string') {
                        let v = this.labels.find(l => l.name === fillMatch[3])?.line;
                        if (v === undefined) {
                            this.sendEvent('output', 'console', `Error: label ${fillMatch[3]} not found`, this._sourceFile, l);
                            this.sendEvent('stopOnException', undefined);
                            return;
                        } else {
                            this.variables.get('mem')!.value[label] = v;
                        }
                    } else {
                        this.variables.get('mem')!.value[label] = value;
                    }
                }
            }
        }

    }


    // execute R type instruction and update global variables
    private executeRType(op: string, r1: number, r2: number, offset: number | string): boolean {
        switch (op) {
            case 'add':
                // check if offset is a number
                if (typeof offset === 'number') {
                    if (offset > 7 || offset < 0) {
                        this.sendEvent('output', 'console', `Error: register ${offset} is not valid`, this._sourceFile, this.currentLine);
                        this.sendEvent('stopOnException', undefined);
                        return false;
                    }
                    // add r1 and r2 and store in r3, all the number are 32bit
                    var result: number = Number(this.variables.get(`reg ${r1}`)?.value) + Number(this.variables.get(`reg ${r2}`)?.value);
                    // if the result is over 32bit, truncate it
                    result = result & 0xFFFFFFFF;
                    const v = new RuntimeVariable(`reg ${offset}`, result);
                    this.variables.set(`reg ${offset}`, v);
                } else {
                    this.sendEvent('output', 'console', `Error: should be a register for destReg`, this._sourceFile, this.currentLine);
                    this.sendEvent('stopOnException', undefined);
                    return false;
                }
                break;
            case 'nor':
                // check if offset is a number
                if (typeof offset === 'number') {
                    if (offset > 7) {
                        this.sendEvent('output', 'console', `Error: register ${offset} is not valid`, this._sourceFile, this.currentLine);
                        this.sendEvent('stopOnException', undefined);
                        return false;
                    }
                    // nor r1 and r2 and store in r3, all the number are 32bit
                    var result: number = ~(Number(this.variables.get(`reg ${r1}`)?.value) | Number(this.variables.get(`reg ${r2}`)?.value));
                    // if the result is over 32bit, truncate it
                    result = result & 0xFFFFFFFF;
                    const v = new RuntimeVariable(`reg ${offset}`, result);
                    this.variables.set(`reg ${offset}`, v);
                }
                else {
                    this.sendEvent('output', 'console', `Error: should be a register for destReg`, this._sourceFile, this.currentLine);
                    this.sendEvent('stopOnException', undefined);
                    return false;
                }
                break;
            case 'beq':
                // check if offset is a number
                if (typeof offset === 'number') {
                    if (this.variables.get(`reg ${r1}`)?.value === this.variables.get(`reg ${r2}`)?.value) {
                        this.currentLine = offset - 1;
                    }
                } else {
                    // load the label
                    var label = this.labels.find((label) => label.name === offset);
                    if (label) {
                        if (this.variables.get(`reg ${r1}`)?.value === this.variables.get(`reg ${r2}`)?.value) {
                            this.currentLine = label.line - 1;
                        }
                    }
                    else {
                        this.sendEvent('output', 'console', `Error: label ${offset} not found`, this._sourceFile, this.currentLine);
                        this.sendEvent('stopOnException', undefined);
                        return false;
                    }
                }
                break;
            case 'lw':
                var num_offset;
                // check if offset is a number
                if (typeof offset === 'string') {
                    // load the label
                    var label = this.labels.find((label) => label.name === offset);
                    if (label) {
                        num_offset = label.line;
                    }
                    else {
                        this.sendEvent('output', 'console', `Error: label ${offset} not found`, this._sourceFile, this.currentLine);
                        this.sendEvent('stopOnException', undefined);
                        return false;
                    }
                } else {
                    num_offset = offset;
                }
                var address = this.variables.get(`reg ${r1}`)?.value + num_offset;
                var value = this.variables.get('mem')?.value[address];
                if (value === undefined) {
                    this.sendEvent('output', 'console', `Error: address ${address} may not be initialized or out of bound`, this._sourceFile, this.currentLine);
                    this.sendEvent('stopOnException', undefined);
                    return false;
                }
                const v = new RuntimeVariable(`reg ${r2}`, value);
                this.variables.set(`reg ${r2}`, v);
                break;
            case 'sw':
                var num_offset;
                // check if offset is a number
                if (typeof offset === 'string') {
                    // load the label
                    var label = this.labels.find((label) => label.name === offset);
                    if (label) {
                        num_offset = label.line;
                    }
                    else {
                        this.sendEvent('output', 'console', `Error: label ${offset} not found`, this._sourceFile, this.currentLine);
                        this.sendEvent('stopOnException', undefined);
                        return false;
                    }
                } else {
                    num_offset = offset;
                }
                address = this.variables.get(`reg ${r1}`)?.value + num_offset;
                value = Number(this.variables.get(`reg ${r2}`)?.value);

                this.variables.get('mem')!.value[address] = value;
                break;
            default:
                this.sendEvent('output', 'console', `Error: unknown operation ${op}`, this._sourceFile, this.currentLine);
                this.sendEvent('stopOnException', undefined);
                return false;
        }
        return true;
    }

    // execute J type instruction and update global variables
    private executeJType(op: string, r1: number, r2: number): boolean {
        switch (op) {
            case 'jalr':
                const v = new RuntimeVariable(`reg ${r2}`, this.currentLine + 1);
                this.variables.set(`reg ${r2}`, v);
                this.currentLine = Number(this.variables.get(`reg ${r1}`)?.value) - 1;
                break;
            default:
                this.sendEvent('output', 'console', `Error: unknown op ${op}`, this._sourceFile, this.currentLine);
                this.sendEvent('stopOnException', undefined);
                return false;
        }
        return true;
    }

    // execute O type instruction and update global variables
    private executeOType(op: string): boolean {
        switch (op) {
            case 'halt':
                // print out all the registers
                for (let i = 0; i < 8; i++) {
                    this.sendEvent('output', 'console', `reg ${i}: ${this.variables.get(`reg ${i}`)?.value}`, this._sourceFile, 0);
                }
                this.sendEvent('end');
                return false;
            case 'noop':
                break;
            default:
                this.sendEvent('output', 'console', `Error: unknown op ${op}`, this._sourceFile, this.currentLine);
                this.sendEvent('stopOnException', undefined);
                return false;
        }
        return true;
    }
    /**
     * return true on stop
     */
    private findNextStatement(stepEvent?: string): boolean {

        for (let ln = this.currentLine; ln < this.sourceLines.length; ln++) {

            // is there a source breakpoint?
            const breakpoints = this.breakPoints.get(this._sourceFile);
            if (breakpoints) {
                const bps = breakpoints.filter(bp => bp.line === ln);
                if (bps.length > 0) {

                    // send 'stopped' event
                    this.sendEvent('stopOnBreakpoint');

                    // the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
                    // if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
                    if (!bps[0].verified) {
                        bps[0].verified = true;
                        this.sendEvent('breakpointValidated', bps[0]);
                    }

                    this.currentLine = ln;
                    return true;
                }
            }

            const line = this.getLine(ln);
            if (line.length > 0) {
                this.currentLine = ln;
                break;
            }
        }
        if (stepEvent) {
            this.sendEvent(stepEvent);
            return true;
        }
        return false;
    }

    /**
     * "execute a line" of the readme markdown.
     * Returns true if execution sent out a stopped event and needs to stop.
     */
    private executeLine(ln: number): boolean {

        const line = this.getLine(ln);

        // use regex to parse lc2k assembly (e.g. label lw 0 3 label1 )
        var op: string | undefined = undefined;
        var reg1: number | undefined = undefined;
        var reg2: number | undefined = undefined;
        var offset: number | string;
        const R_INST_REGEX = /^([^\s]*)\s+(add|nor|lw|sw|beq)\s+([^\s]*)\s+([^\s]*)\s+([^\s]*)(\s+)?(.*)?/g;
        const J_INST_REGEX = /^([^\s]*)\s+(jalr)\s+([^\s]+)\s+([^\s]+)(\s+)?(.*)?/g;
        const O_INST_REGEX = /^([^\s]*)\s+(halt|noop)(\s+)?(.*)?/g;
        const FILL_REGEX = /^([^\s]*)\s+(\.fill)\s+([^\s]+)(\s+)?(.*)?/g;
        let match: RegExpExecArray | null;
        if (match = R_INST_REGEX.exec(line)) {
            // R-type instruction
            op = match[2];
            reg1 = parseInt(match[3]);
            reg2 = parseInt(match[4]);
            offset = !isNaN(Number(match[5])) ? parseInt(match[5]) : match[5];
            if (!this.executeRType(op, reg1, reg2, offset)) {
                return true;
            }
        } else if (match = J_INST_REGEX.exec(line)) {
            // J-type instruction
            op = match[2];
            reg1 = parseInt(match[3]);
            reg2 = parseInt(match[4]);
            if (!this.executeJType(op, reg1, reg2)) {
                return true;
            }
        } else if (match = O_INST_REGEX.exec(line)) {
            // O-type instruction
            op = match[2];
            if (!this.executeOType(op)) {
                return true;
            }
        } else if (match = FILL_REGEX.exec(line)) {
            // .fill instruction
            op = match[2];
            offset = match[3];
        } else {
            // invalid instruction
            this.sendEvent('output', 'console', `Error: invalid instruction ${line}`, this._sourceFile, ln);
            this.sendEvent('stopOnException', undefined);
            return true;
        }

        // nothing interesting found -> continue
        return false;
    }

    private async verifyBreakpoints(path: string): Promise<void> {

        const bps = this.breakPoints.get(path);
        if (bps) {
            bps.forEach(bp => {
                if (!bp.verified && bp.line < this.sourceLines.length) {
                    const srcLine = this.getLine(bp.line);

                    // if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
                    if (srcLine.length === 0 || srcLine.indexOf('+') === 0) {
                        bp.line++;
                    }
                    // if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
                    if (srcLine.indexOf('-') === 0) {
                        bp.line--;
                    }
                    // don't set 'verified' to true if the line contains the word 'lazy'
                    // in this case the breakpoint will be verified 'lazy' after hitting it once.
                    if (srcLine.indexOf('lazy') < 0) {
                        bp.verified = true;
                        this.sendEvent('breakpointValidated', bp);
                    }
                }
            });
        }
    }

    private sendEvent(event: string, ...args: any[]): void {
        setTimeout(() => {
            this.emit(event, ...args);
        }, 0);
    }

    private normalizePathAndCasing(path: string) {
        if (this.fileAccessor.isWindows) {
            return path.replace(/\//g, '\\').toLowerCase();
        } else {
            return path.replace(/\\/g, '/');
        }
    }
}
