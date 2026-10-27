const PHONE_PATTERN: RegExp = /^\+?[0-9\s\-\(\)]{7,15}$/;
export default class Phone {
    constructor(readonly value: string) {
        if(!PHONE_PATTERN.test(value.replace(/\D/g, ''))) {
            throw new Error('Phone is not valid');
        };
    }
}