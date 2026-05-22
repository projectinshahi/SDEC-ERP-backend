import { Router } from 'express';
import { getUsers, createUser, getUserCount, updateUser, deleteUser } from '../controllers/user.controller';

const router = Router();

router.get('/count', getUserCount);
router.get('/', getUsers);
router.post('/', createUser);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);

export default router;
