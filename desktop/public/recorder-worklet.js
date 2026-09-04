class ReasonixRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.buffer = new Float32Array(this.bufferSize);
    this.bytesWritten = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        if (this.bytesWritten > 0) {
          const remaining = this.buffer.slice(0, this.bytesWritten);
          this.port.postMessage(remaining, [remaining.buffer]);
          this.buffer = new Float32Array(this.bufferSize);
          this.bytesWritten = 0;
        }
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) {
      return true;
    }
    const channelData = input[0];
    let offset = 0;
    while (offset < channelData.length) {
      const remaining = this.bufferSize - this.bytesWritten;
      const toCopy = Math.min(remaining, channelData.length - offset);
      this.buffer.set(channelData.subarray(offset, offset + toCopy), this.bytesWritten);
      this.bytesWritten += toCopy;
      offset += toCopy;

      if (this.bytesWritten >= this.bufferSize) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.bufferSize);
        this.bytesWritten = 0;
      }
    }
    return true;
  }
}

registerProcessor("reasonix-recorder-worklet", ReasonixRecorderProcessor);
