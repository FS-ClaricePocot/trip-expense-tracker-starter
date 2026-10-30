L4 AI Training Product Requirements

# Overview

The Trip Expense Tracker is the sample app every developer builds in the L4 AI Developer Training Plan. A user registers, creates a trip, adds the people on it, and records who paid for what. The app shows what each person owes or is owed, and the fewest payments needed to settle up.

The app has a frontend, a backend API and a database. The scope is kept small on purpose so the whole build fits the $15 training budget.

# Goals

- A user can set up a trip and its people in a few steps.
- Adding an expense takes four inputs: what, how much, who paid, who shares it.
- Balances are always correct to the cent and always add up to zero.
- Settling up needs as few payments as possible.
- No user can see or change another user's trips.

# Roles

The app has one role. Everyone who uses it registers an account.

|Role|Description|Can do|
|---|---|---|
|User|Someone tracking a trip's shared spending|Register, log in and out; create and manage their own trips, people, expenses and payments|


Ownership rule: a user can only see and change their own trips and everything in them. Being logged in is not enough; every action also checks that the trip belongs to the user.

People on a trip are names only. They do not have accounts.

# Assumptions

- Money moves outside the app. The app only records that a payment was made.
- Email and password login only. No email verification or password reset.
- One currency. Amounts have no currency setting or conversion.
- Equal splits only. An expense is split equally between the people who share it.
- No editing. Trips, people, expenses and payments can be added and deleted, not edited. A mistake is fixed by deleting and adding again.
- Amounts are stored as whole cents, never as floating-point numbers.

# Key terms

|Term|Meaning|
|---|---|
|Trip|A named group of people and expenses, owned by one user|
|Person|Someone on a trip, identified by a name unique within that trip|
|Expense|An amount one person paid, shared equally by one or more people on the trip|
|Balance|What a person paid minus their share of expenses, adjusted by payments. Positive means they are owed; negative means they owe|
|Suggested payment|A payment the app proposes so that all balances reach zero|
|Payment|A suggested payment the user has marked as paid|

# MVP scope

Each feature gets its own spec in docs/specs/features/ and its own plan in docs/plans/.

|#|Feature|What it includes|Done when|
|---|---|---|---|
|F1|Registration and login|Register with email and password, log in and out, hashed passwords; login and ownership checks on every trip endpoint|A logged-out visitor cannot reach any trip, and a user cannot see another user's trip|
|F2|Trips|Create a trip with a name, list your trips, delete a trip|A user sees only their own trips|
|F3|People|Add and remove people on a trip|A person in any expense cannot be removed|
|F4|Expenses|Add an expense with a description, amount, payer and participants (everyone by default); list and delete expenses|Each expense is split equally to the cent|
|F5|Balances|Each person's balance, shown as "is owed" or "owes"|All balances on a trip add up to exactly zero|
|F6|Settle up|Suggested payments; mark a suggested payment as paid; delete a payment|After all suggested payments are marked paid, every balance is zero|

  

Code follows the basic logging rules: use the logger, never log sensitive data, and leave no print statements.

# Business rules

|#|Rule|
|---|---|
|R1|An expense amount is greater than zero.|
|R2|An expense has one payer and at least one participant, all on the same trip. The payer does not have to be a participant.|
|R3|A share is the amount divided equally between participants, rounded down to the cent. Leftover cents go one each to participants in the order they were added to the trip.|
|R4|A person's balance = what they paid − their shares + payments they made − payments they received.|
|R5|All balances on a trip always add up to exactly zero.|
|R6|Suggested payments: the person who owes the most pays the person owed the most, repeated until all balances are zero.|
|R7|A person cannot be removed while they are in any expense or payment.|
|R8|Deleting a trip deletes everything in it, after the user confirms.|

## Worked examples

These are the reference cases for F4–F6 tests.

Example 1: Basic trip. People: Sam, Alex, Jo. Sam pays 90.00 for dinner and Alex pays 30.00 for a taxi, both shared by all three.

|Person|Paid|Share|Balance|
|---|---|---|---|
|Sam|90.00|40.00|is owed 50.00|
|Alex|30.00|40.00|owes 10.00|
|Jo|0.00|40.00|owes 40.00|

  

Suggested payments: Jo pays Sam 40.00; Alex pays Sam 10.00.

Example 2: Rounding. 10.00 shared by Sam, Alex and Jo gives shares of 3.34, 3.33 and 3.33.

Example 3: After a payment. In Example 1, marking "Jo pays Sam 40.00" as paid leaves one suggested payment: Alex pays Sam 10.00.

# After the core

|Feature|When|
|---|---|
|Editing expenses, uneven splits, CSV export|Only if budget remains|
|Currencies, third-party integrations, sharing trips with other users, password reset, mobile apps|Out of scope|

