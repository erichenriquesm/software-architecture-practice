import axios from 'axios';

import { UserPayload, UserSender } from "../../application/account/ports/userSender";

const WEBHOOK_URL = 'https://webhook.site/f5218609-7098-4bf0-a5b9-d38b23d02476';

// Cada elo da corrente também é um UserSender: se falhar, repassa para o próximo.
abstract class FallbackUserSender implements UserSender {
    constructor (readonly next?: UserSender) {}

    protected abstract trySend(user: UserPayload): Promise<void>;

    async send(user: UserPayload): Promise<void> {
        try {
            await this.trySend(user);
        } catch (e) {
            if (!this.next) throw e;
            await this.next.send(user);
        }
    }
}

export class SendUserByFetch extends FallbackUserSender {
    protected async trySend(user: UserPayload): Promise<void> {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(user)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
    }
}

export class SendUserByAxios extends FallbackUserSender {
    protected async trySend(user: UserPayload): Promise<void> {
        await axios.post(WEBHOOK_URL, user);
    }
}
