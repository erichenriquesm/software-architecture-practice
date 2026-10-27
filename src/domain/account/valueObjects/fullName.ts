export default class FullName {
    constructor(readonly value: string) {
        const [_, surname] = value.split(" ");

        const hasSurname = !!surname;
        if (!hasSurname) throw new Error("Full name is not set");
    }
}