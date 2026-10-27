import { RegisterUserInputDTO } from "../../app/account/dtos/registerUserInputDTO";
import axios from 'axios';

interface FallbackProcessor {
    next: FallbackProcessor | undefined;
    process(input: any): Promise<any>;
}


export class SendUserByFecthProcessor implements FallbackProcessor {
    constructor (
        readonly next: FallbackProcessor | undefined
    ) {}

    async process(input: RegisterUserInputDTO): Promise<any> {
        try {
            throw new Error('Service ended');
            const response = await fetch('https://webhook.site/5342ac4d-f935-4339-958b-0b55f53e14b2', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(input)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
        } catch (e) {
            if (!this.next) throw e;
            return await this.next.process(input);
        }
    }
}

export class SendUserByAxiosProcessor implements FallbackProcessor {
    constructor (
        readonly next: FallbackProcessor | undefined
    ) {}

    async process(input: RegisterUserInputDTO): Promise<any> {
        try {
            const response = await axios.post('https://webhook.site/5342ac4d-f935-4339-958b-0b55f53e14b2', input);
            return response.data;
        } catch (e) {
            if (!this.next) throw e;
            return await this.next.process(input);
        }
    }
}