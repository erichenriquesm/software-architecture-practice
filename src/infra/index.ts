import { SendUser } from "../application/account/usecases/sendUser";
import { SendUserByAxios, SendUserByFetch } from "./gateways/fallbackUserSender";

// Composition root: único lugar que conhece as implementações concretas.
const userSender = new SendUserByFetch(new SendUserByAxios());
const sendUser = new SendUser(userSender);

try {
    await sendUser.exec({
        name: 'Eric Motta',
        email: 'eric@gmail.com',
        phone: '5544999999999'
    });
    console.log('Usuário enviado com sucesso');
} catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Falha ao enviar usuário: ${message}`);
}
