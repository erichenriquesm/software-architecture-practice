import Account from "../app/account/entities/account";
import { SendUser } from "../app/account/usecases/sendUser";
import Email from "../app/account/valueObjects/email";
import FullName from "../app/account/valueObjects/fullName";
import Phone from "../app/account/valueObjects/phone";

const account = Account.create(
    new FullName('Eric Motta'),
    new Email('eric@gmail.com'),
    new Phone('5544999999999')
);

const sendUser = new SendUser()

try {
    await sendUser.exec(account);
    console.log('Usuário enviado com sucesso');
} catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Falha ao enviar usuário: ${message}`);
}