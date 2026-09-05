import { IsNotEmpty, IsString } from 'class-validator';

export class ResetWorkspaceUserPasswordDto {
  @IsNotEmpty()
  @IsString()
  userId: string;
}