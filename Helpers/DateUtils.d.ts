export {};
declare global {
    interface Date {
        /** Minimum date value */
        minValue: Date;
        /** Add a number of days */
        addDays(days: number): Date;
        /** Add a number of minutes */
        addMinutes(mins: number): Date;
        /** Add a number of seconds */
        addSeconds(secs: number): Date;
        /** Get the number of days between two dates */
        diffDays(date: Date): number;
        /** Get the number of hours between two dates */
        diffHours(date: Date): number;
        /** Get the number of minutes between two dates */
        diffMinutes(date: Date): number;
        /** Get the number of seconds between two dates */
        diffSeconds(date: Date): number;
    }
}