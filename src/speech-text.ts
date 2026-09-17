/** Incremental speech projection: speak link labels, never citation destinations. */
export class SpeechTextFilter {
	private mode: "text" | "label" | "after-label" | "destination" = "text";
	private depth = 0;
	private escaped = false;
	private prefix = "";
	private handle = false;

	push(fragment: string): string {
		let out = "";
		const emit = (character: string) => {
			// Only a fixed-size prefix is held; arbitrarily long handles are discarded.
			if (this.handle) {
				if (/[\w:/%.-]/.test(character)) return;
				this.handle = false;
			}
			this.prefix += character;
			while (this.prefix && !"corpus:".startsWith(this.prefix.toLowerCase())) {
				out += this.prefix[0];
				this.prefix = this.prefix.slice(1);
			}
			if (this.prefix.toLowerCase() === "corpus:") {
				this.prefix = "";
				this.handle = true;
			}
		};
		for (const character of fragment) {
			// A hard message/paragraph break ends an incomplete link as well.
			if (character === "\n") {
				this.mode = "text";
				this.depth = 0;
				this.escaped = false;
				emit(character);
				continue;
			}
			if (this.mode === "destination") {
				if (this.escaped) this.escaped = false;
				else if (character === "\\") this.escaped = true;
				else if (character === "(") this.depth++;
				else if (character === ")" && --this.depth === 0) this.mode = "text";
				continue;
			}
			if (this.mode === "after-label") {
				this.mode = "text";
				if (character === "(") {
					this.mode = "destination";
					this.depth = 1;
					continue;
				}
			}
			if (this.escaped) {
				this.escaped = false;
				emit(character);
			} else if (character === "\\") {
				this.escaped = true;
			} else if (character === "[") {
				this.mode = "label";
				this.depth++;
			} else if (character === "]" && this.mode === "label") {
				if (--this.depth === 0) this.mode = "after-label";
			} else {
				emit(character);
			}
		}
		return out;
	}

	flush(): string {
		const tail = this.prefix;
		this.prefix = "";
		this.handle = false;
		this.mode = "text";
		this.depth = 0;
		this.escaped = false;
		return tail;
	}
}
