import { SendUserByAxiosProcessor, SendUserByFecthProcessor } from "../../../infra/util/fallback";
import { UseCase } from "../contracts/useCase";

import Account from "../entities/account";

export class SendUser implements UseCase {
    async exec(input: Account) {
        const sendUserByAxiosProcessor = new SendUserByAxiosProcessor(undefined)
        const sendUserByFecthProcessor = new SendUserByFecthProcessor(sendUserByAxiosProcessor);
        

        const { name, email, phone} = input.getAccount();

        return await sendUserByFecthProcessor.process({
            name: name.value,
            email: email.value,
            phone: phone.value
        });
    }
}