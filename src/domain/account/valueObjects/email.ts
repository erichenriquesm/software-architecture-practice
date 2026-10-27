const EMAIL_PATTERN: RegExp = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
export default class Email {
    constructor(readonly value: string) {
        if(!EMAIL_PATTERN.test(value)) {
            throw new Error('Email is not valid');
        };
    }
}