// Porta de saída: a aplicação diz O QUE precisa, a infra decide COMO (fetch, axios, fila...).
export type UserPayload = {
    name: string,
    email: string,
    phone: string
}

export interface UserSender {
    send(user: UserPayload): Promise<void>;
}
