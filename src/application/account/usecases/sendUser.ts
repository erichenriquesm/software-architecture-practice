import { UseCase } from "../../contracts/useCase";
import { SendUserInputDTO } from "../dtos/sendUserInputDTO";
import { UserSender } from "../ports/userSender";

import Account from "../../../domain/account/account";
import Email from "../../../domain/account/valueObjects/email";
import FullName from "../../../domain/account/valueObjects/fullName";
import Phone from "../../../domain/account/valueObjects/phone";

export class SendUser implements UseCase {
    constructor(private readonly userSender: UserSender) {}

    async exec(input: SendUserInputDTO): Promise<void> {
        // O domínio valida as regras; a aplicação só orquestra.
        const account = Account.create(
            new FullName(input.name),
            new Email(input.email),
            new Phone(input.phone)
        );

        const { name, email, phone } = account.getAccount();

        await this.userSender.send({
            name: name.value,
            email: email.value,
            phone: phone.value
        });
    }
}
