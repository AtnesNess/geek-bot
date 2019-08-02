import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

const client = new Client({
    user: 'cprodzkswvivtu',
    host: 'ec2-79-125-4-72.eu-west-1.compute.amazonaws.com',
    database: 'deaulcs2pttcl5',
    password: '8818cbe0e53fd1bdd94bb04713c539ea7ebff763c2a4acfb3d81c0c6592329be',
    port: 5432,
    ssl: true
});

client.connect();

export class DBError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DBError';
    }
}

export class DBInstanceNotFoundError extends DBError {
    constructor(message) {
        super(message);
        this.name = 'DBInstanceNotFoundError';
    }
}

class DBCollection {
    async execQuery(query) {
        console.log(query);
        const res = await client.query(query);
        
        // if (err) {
        //     throw new DBError(err);
        // }

        return res;
    }

    handleInstances(collection) {
        const isArray = Array.isArray(collection)
        if (!isArray) {
            collection = [collection];
        }
        const _this = this;

        const newCollection = collection.map(instance => ({
            ...instance.data,
            id: instance.id,
            save: async function() {
                const {save, id, remove, ...data} = this;
                console.log(this, 'this');

                _this.execQuery(`UPDATE ${_this.table} SET data='${JSON.stringify(data)}' WHERE id=${id}`);
            },
            remove: async function() {
                const {id} = this;

                _this.execQuery(`DELETE FROM ${_this.table} WHERE id=${id}`);
            }
        }));

        if (!isArray) {
            return newCollection[0];
        }

        return newCollection;
    }

    makeParams(props) {
        if (!Array.isArray(props)) {
            props = [props];
        }

        return '(' + props.map(obj => 
            Object.keys(obj).map(key => `data ->> '${key}'='${obj[key]}'`).join(' AND ')
        ).join(') OR (') + ')';
    }

    async getAll() {
        const res = await this.execQuery(`SELECT * FROM ${this.table}`);
        
        return this.handleInstances(res.rows);
    }
    
    async getItem(props) {
        const params = this.makeParams(props);
        const res = await this.execQuery(`SELECT * FROM ${this.table} WHERE ${params}`);
        
        if (res.rowCount !== 1) {
            throw new DBInstanceNotFoundError('There should be only 1 instance, but its ' + res.rowCount);
        }

        return this.handleInstances(res.rows[0]);
    }

    async updateItems(props, data) {
        const params = this.makeParams(props);
        const res = await this.execQuery(`UPDATE ${this.table} SET data='${JSON.stringify(data)}' WHERE ${params} RETURNING *`);
        
        return this.handleInstances(res.rows[0]);
    }

    async getItemById(id) {
        const res = await this.execQuery(`SELECT * FROM ${this.table} WHERE id=${id}`);
        
        if (res.rowCount !== 1) {
            throw new DBInstanceNotFoundError('There should be only 1 instance, but its ' + res.rowCount);
        }

        return this.handleInstances(res.rows[0]);
    }

    async filterItems(props) {
        const params = this.makeParams(props);
        const res = await this.execQuery(`SELECT * FROM ${this.table} WHERE ${params}`);

        return this.handleInstances(res.rows);
    }

    async addItem(props) {
        const res = await this.execQuery(`INSERT INTO ${this.table} (data) VALUES ('${JSON.stringify(props)}')  RETURNING *`);

        return this.handleInstances(res.rows[0]);
    }
}

class UsersCollection extends DBCollection {
    constructor() {
        super();
        this.table = 'tg_users';
    }

    async getUser(chatId) {
        return await this.getItem({chatId});
    }

    async getAdmins() {
        return await this.filterItems({admin: true});
    }

    async addUser(props) {
        return await this.addItem(props);
    }
}

class TasksCollection extends DBCollection {
    constructor() {
        super();
        this.table = 'tg_tasks';
    }

    async getTasks() {
        return await this.getAll();
    }

    async addTask(props) {
        return await this.addItem(props);
    }
}

class StateCollection extends DBCollection {
    constructor() {
        super();
        this.table = 'tg_info';
    };

    async updateCurrentTaskId(id) {
        await this.updateItems({key: 'currentTaskId'}, {key: 'currentTaskId', value: id});
    }

    async getCurrentTaskId() {
        return (await this.getItem({key: 'currentTaskId'})).value;
    }

    async updateCurrentUserId(id) {
        await this.updateItems({key: 'currentUserId'}, {key: 'currentUserId', value: id});
    }

    async getCurrentUserId() {
        return (await this.getItem({key: 'currentUserId'})).value;
    }

    async updateChatId(id) {
        await this.updateItems({key: 'chatId'}, {key: 'chatId', value: id});
    }

    async getChatId() {
        return (await this.getItem({key: 'chatId'})).value;
    }
}

export const users = new UsersCollection();
export const tasks = new TasksCollection();
export const state = new StateCollection();
