import Account from "../app/account/entities/account";
import Email from "../app/account/valueObjects/email";
import FullName from "../app/account/valueObjects/fullName";
import Phone from "../app/account/valueObjects/phone";

const account = Account.create(
    new FullName('Eric Motta'),
    new Email('eric@gmail.com'),
    new Phone('5544999999999')
);

console.log(account.getEmail());