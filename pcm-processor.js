class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Float32Array(0);
        
        this.port.onmessage = (event) => {
            const { samples } = event.data;
            // Adiciona os novos dados ao buffer existente
            const newBuffer = new Float32Array(this.buffer.length + samples.length);
            newBuffer.set(this.buffer);
            newBuffer.set(samples, this.buffer.length);
            this.buffer = newBuffer;
        };
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        if (output.length === 0) return true;

        const channelL = output[0];
        const channelR = output.length > 1 ? output[1] : null;

        // Pega o mínimo entre o tamanho do buffer e o que o áudio precisa
        const framesToProcess = Math.min(channelL.length, Math.floor(this.buffer.length / 2));
        
        if (framesToProcess > 0) {
            for (let i = 0; i < framesToProcess; i++) {
                channelL[i] = this.buffer[i * 2]; // Canal Esquerdo
                if (channelR) channelR[i] = this.buffer[i * 2 + 1]; // Canal Direito
            }
            // Remove a parte do buffer que já foi processada
            this.buffer = this.buffer.slice(framesToProcess * 2);
        } else {
            // Se não houver dados, preenche com silêncio
            channelL.fill(0);
            if (channelR) channelR.fill(0);
        }
        return true;
    }
}
registerProcessor('pcm-processor', PCMProcessor);