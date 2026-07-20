import { v4 as uuidv4 } from 'uuid';

import Email from "../valueObjects/email";
import FullName from "../valueObjects/fullName";
import Phone from "../valueObjects/phone";

export default class Account {
    constructor (private name: FullName, private email: Email, private phone: Phone, private id: string) {}

    static create(name: FullName, email: Email, phone: Phone): Account {
        return new Account(name, email, phone, uuidv4());
    }

    getEmail() {
        return this.email.value;
    }

    getId() {
        return this.id;
    }
}