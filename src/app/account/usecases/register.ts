import { UseCase } from "../contracts/useCase";
import { RegisterUserInputDTO } from "../dtos/registerUserInputDTO";
import { RegisterUserOutputDTO } from "../dtos/registerUserOutputDTO";
import Account from "../entities/account";
import Email from "../valueObjects/email";
import FullName from "../valueObjects/fullName";
import Phone from "../valueObjects/phone";

export class Register implements UseCase {
    exec(input: RegisterUserInputDTO): RegisterUserOutputDTO {
        const output = Account.create(
            new FullName(input.name),
            new Email(input.email),
            new Phone(input.phone)
        );
        return {
            id: output.getId()
        }
    }
}