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
            const response = await fetch('https://webhook.site/f5218609-7098-4bf0-a5b9-d38b23d02476', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(input)
            });

            if(!response.ok && this.next) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            if (!response.ok) {
                return response.json();
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
            const response = await axios.post('https://webhook.site/f5218609-7098-4bf0-a5b9-d38b23d02476', input);
            return response.data;
        } catch (e) {
            if (!this.next) throw e;
            return await this.next.process(input);
        }
    }
}